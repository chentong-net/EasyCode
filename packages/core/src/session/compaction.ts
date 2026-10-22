import type { Message, Part, ToolDefinition } from "@easycode/schema"
import { addUsage } from "@easycode/schema"

import type { CoreConfig } from "../config.js"
import { describeError } from "../llm/error.js"
import type { LLMClient, LLMMessage } from "../llm/types.js"
import { newMessageID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { estimateTextTokens } from "../util/token.js"
import { buildLLMMessages, selectHistoryMessages, estimateRequestTokens } from "./history.js"
import type { SessionHandle } from "./runtime.js"

/**
 * 历史压缩。
 *
 * 触发条件是「估算的请求 token 超过上下文窗口减去预留空间」。预留空间取
 * 「输出预算」与「缓冲区」的较大值：前者保证模型还有地方写回复，
 * 后者避免在临界点上反复触发压缩。
 *
 * 三个刻意的设计：
 *
 * 1. **用同一个模型做摘要**。不引入第二个模型意味着不需要额外配置，
 *    代价是摘要本身也消耗 token。摘要请求刻意不携带工具，避免模型
 *    在总结时又去调用工具。
 * 2. **保留最近一段原文**。摘要会丢失细节（具体的行号、变量名），
 *    而接下来的工作恰恰最需要这些细节。所以尾部固定留一段原文不压缩。
 * 3. **失败即放弃**。摘要请求失败、返回空文本、或本身超出上下文限制时，
 *    直接返回「未压缩」，不改变任何状态。宁可这一轮带着超限风险去请求
 *    （由溢出恢复路径兜底），也不要把历史毁掉。
 */

/** 根据上下文窗口推导出的压缩预算，不再使用与窗口无关的固定值。 */
export interface CompactionBudget {
  contextWindow: number
  /** 为 provider 实际声明的输出预留，最多占窗口的四分之一。 */
  outputTokens: number
  /** 协议模板和估算误差的安全余量。 */
  safetyMargin: number
  /** 触发 provider 请求前的硬输入上限。 */
  hardInputTokens: number
  /** 达到该值时开始自动压缩。 */
  triggerTokens: number
  /** 压缩后希望达到的目标大小。 */
  targetTokens: number
  /** 压缩后原样保留的最近原文，按估算 token 计 */
  keepTokens: number
  /** 摘要请求最多可以使用的输入 token。 */
  summaryInputTokens: number
  /** 摘要本身允许生成的最大 token。 */
  summaryOutputTokens: number
}

/** 摘要请求里单条工具结果的字符上限。压缩的目的就是缩小体积，这里要更激进。 */
const TRANSCRIPT_TOOL_OUTPUT_LIMIT = 2_000

export type CompactionStatus = "skipped" | "completed" | "failed"

export interface CompactionOutcome {
  status: CompactionStatus
  reason: string
  beforeTokens?: number
  afterTokens?: number
  attempts: number
  usedFallback: boolean
}

export interface CompactionDeps {
  config: CoreConfig
  llm: LLMClient
  logger?: Logger
}

export interface CompactInput {
  handle: SessionHandle
  /** 当前纪元的 baseline 序号 */
  baselineSeq: number
  /** 本次请求的完整系统提示词（agent 提示词 + baseline） */
  system: string[]
  /** 本次请求的工具定义 */
  tools: ToolDefinition[]
  /** 本次请求的模型消息，用于估算占用 */
  messages: LLMMessage[]
  signal?: AbortSignal
}

export interface CompactionManager {
  /** 当前会话窗口对应的预算，Runner 也使用其中的输出预留。 */
  budget(): CompactionBudget
  /** 估算当前请求的 token 占用 */
  estimate(system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number
  /** 必要时压缩；调用方根据 completed 状态决定是否重建请求。 */
  compactIfNeeded(input: CompactInput): Promise<CompactionOutcome>
  /** 上下文超限后的强制压缩。跳过节流判断，直接尝试。 */
  compactAfterOverflow(input: CompactInput): Promise<CompactionOutcome>
}

export const createCompactionManager = (deps: CompactionDeps): CompactionManager => {
  const logger = deps.logger ?? createLogger("session.compaction")
  const options = calculateCompactionBudget(deps.config)

  const estimate = (system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number =>
    estimateRequestTokens(system, messages, tools)

  const compactIfNeeded = async (input: CompactInput): Promise<CompactionOutcome> => {
    const estimated = estimate(input.system, input.messages, input.tools)
    const last = input.handle.state.messages.at(-1)
    const afterCompaction = last?.role === "compaction"

    if (afterCompaction ? estimated <= options.hardInputTokens : estimated <= options.triggerTokens) {
      return { status: "skipped", reason: "context_fits", beforeTokens: estimated, attempts: 0, usedFallback: false }
    }

    logger.info("上下文接近上限，开始压缩", {
      sessionID: input.handle.id,
      estimatedTokens: estimated,
      triggerTokens: options.triggerTokens,
      hardInputTokens: options.hardInputTokens,
      contextWindow: options.contextWindow,
    })

    return compact(input, "automatic", estimated)
  }

  const compactAfterOverflow = async (input: CompactInput): Promise<CompactionOutcome> => {
    logger.info("模型报告上下文超限，尝试压缩后重试", { sessionID: input.handle.id })
    return compact(input, "overflow", estimate(input.system, input.messages, input.tools))
  }

  const compact = async (
    input: CompactInput,
    reason: "automatic" | "overflow",
    beforeTokens: number,
  ): Promise<CompactionOutcome> => {
    const state = input.handle.state
    const history = selectHistoryMessages(state, input.baselineSeq)
    const previous = history.find((message): message is Extract<Message, { role: "compaction" }> =>
      message.role === "compaction",
    )
    const candidates = history.filter((message) => message.role !== "compaction")
    const { head, tail } = splitHistory(candidates, options.keepTokens)

    if (head.length === 0 || tail.length === 0) {
      logger.warn("历史长度不足以压缩，跳过", { sessionID: input.handle.id, head: head.length, tail: tail.length })
      return { status: "failed", reason: "nothing_to_compact", beforeTokens, attempts: 1, usedFallback: false }
    }

    // 已有检查点作为摘要输入，但不混入待压缩消息和保留区。
    const subject = head

    const summary = await summarize({ ...input, previousSummary: previous?.text }, subject)
    if (summary === undefined) {
      return { status: "failed", reason: "summary_failed", beforeTokens, attempts: 1, usedFallback: false }
    }

    await input.handle.append({
      type: "compaction.ended",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      messageID: newMessageID(),
      text: summary,
      recentMessageIDs: tail.map((message) => message.id),
      reason: reason === "overflow" ? "overflow" : "automatic",
      beforeTokens,
      attempts: 1,
      usedFallback: false,
    })

    const afterMessages = buildLLMMessages(input.handle.state, { baselineSeq: input.baselineSeq })
    const afterTokens = estimate(input.system, afterMessages, input.tools)

    logger.info("压缩完成", {
      sessionID: input.handle.id,
      summarizedMessages: subject.length,
      keptMessages: tail.length,
      summaryChars: summary.length,
    })
    return {
      status: "completed",
      reason: reason === "overflow" ? "overflow_compacted" : "automatic_compacted",
      beforeTokens,
      afterTokens,
      attempts: 1,
      usedFallback: false,
    }
  }

  const summarize = async (
    input: CompactInput & { previousSummary?: string },
    subject: Message[],
  ): Promise<string | undefined> => {
    const transcript = renderTranscript(subject)
    const prompt = buildSummaryPrompt(transcript, input.previousSummary)

    // 摘要请求本身要足够小，否则它会自己撞上上下文限制
    const promptTokens = estimateTextTokens(prompt) + estimateTextTokens(SUMMARY_SYSTEM_PROMPT)
    const available = options.summaryInputTokens
    if (promptTokens >= available) {
      logger.warn("待压缩内容过大，摘要请求本身就会超限，已放弃本次压缩", {
        sessionID: input.handle.id,
        promptTokens,
        available,
      })
      return undefined
    }

    const run = async (userPrompt: string): Promise<{ text: string; finish: string } | undefined> => {
      let text = ""
      let finish = ""
      let usage = undefined as Parameters<typeof addUsage>[0] | undefined

      try {
        for await (const event of deps.llm.stream({
          model: input.handle.state.session.model,
          system: [SUMMARY_SYSTEM_PROMPT],
          messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
          // 摘要请求不带工具：避免模型在总结时又去调用工具
          tools: [],
          maxOutputTokens: options.summaryOutputTokens,
          sessionID: input.handle.id,
          ...(input.signal ? { signal: input.signal } : {}),
        })) {
          if (event.type === "text.delta") text += event.text
          if (event.type === "usage") usage = event.usage
          if (event.type === "finish") finish = event.reason
        }
      } catch (error) {
        logger.warn("摘要请求失败，本次不压缩", { sessionID: input.handle.id, error: describeError(error) })
        return undefined
      }

      if (usage) {
        // 摘要调用也是真实开销，计入会话累计用量，否则统计会偏低
        await input.handle.append({
          type: "session.updated",
          sessionID: input.handle.id,
          timestamp: Date.now(),
          usage: addUsage(input.handle.state.session.usage, usage),
        })
      }
      return { text: text.trim(), finish }
    }

    const first = await run(prompt)
    if (!first || first.finish === "length" || first.text.length === 0) return undefined
    if (hasSummaryTemplate(first.text)) return first.text

    const corrected = await run(`${prompt}\n\n${SUMMARY_NUDGE}`)
    if (!corrected || corrected.finish === "length" || corrected.text.length === 0) return undefined
    if (hasSummaryTemplate(corrected.text)) return corrected.text

    logger.warn("摘要没有遵循要求的工作记忆模板", { sessionID: input.handle.id })
    return undefined
  }

  return { budget: () => ({ ...options }), estimate, compactIfNeeded, compactAfterOverflow }
}

/** 从模型窗口推导预算；小窗口下主动收紧输出和保留区，避免固定参数直接失效。 */
export const calculateCompactionBudget = (config: CoreConfig): CompactionBudget => {
  const contextWindow = Math.max(2_048, config.contextWindow)
  const outputTokens = Math.max(
    512,
    Math.min(config.maxOutputTokens, Math.floor(contextWindow * 0.25)),
  )
  const safetyMargin = Math.min(
    4_096,
    Math.max(256, Math.floor(contextWindow * 0.05)),
  )
  const hardInputTokens = Math.max(1_024, contextWindow - outputTokens - safetyMargin)
  const triggerTokens = Math.max(768, Math.floor(hardInputTokens * 0.85))
  const targetTokens = Math.max(512, Math.floor(hardInputTokens * 0.65))
  const keepTokens = Math.max(
    256,
    Math.min(8_000, Math.floor(targetTokens * 0.25)),
  )
  const summaryOutputTokens = Math.max(
    256,
    Math.min(4_096, Math.floor(contextWindow * 0.08)),
  )
  const summaryInputTokens = Math.max(
    512,
    contextWindow - summaryOutputTokens - safetyMargin,
  )

  return {
    contextWindow,
    outputTokens,
    safetyMargin,
    hardInputTokens,
    triggerTokens,
    targetTokens,
    keepTokens,
    summaryInputTokens,
    summaryOutputTokens,
  }
}

/**
 * 把历史按「保留最近一段原文」切成两段。
 *
 * 从尾部往前累加估算 token，直到超过 keepTokens 为止，那之前的全部进 head。
 * 至少要保留一条消息在 tail 里：如果连最后一条都被算进 head，
 * 压缩后模型会完全失去最近发生的事情。
 */
const splitHistory = (history: Message[], keepTokens: number): { head: Message[]; tail: Message[] } => {
  let accumulated = 0
  let splitIndex = history.length

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (!message) break
    const tokens = estimateMessageTokens(message)
    // 保留至少一条消息，同时保证累加不超过预算
    if (accumulated + tokens > keepTokens && accumulated > 0) break
    accumulated += tokens
    splitIndex = index
  }

  // 从用户消息开始保留一个完整交换，避免把问题和回复拆到摘要与原文两侧。
  if (splitIndex > 0 && splitIndex < history.length) {
    for (let index = splitIndex; index >= 0; index -= 1) {
      if (history[index]?.role === "user") {
        splitIndex = index
        break
      }
    }
  }

  // 最后一条消息本身超过保留预算时，仍保留最近的完整交换，避免模型失去当前问题。
  if (splitIndex >= history.length) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === "user") {
        splitIndex = index
        break
      }
    }
  }

  return { head: history.slice(0, splitIndex), tail: history.slice(splitIndex) }
}

/** 估算单条消息的体积，用于决定压缩边界。 */
const estimateMessageTokens = (message: Message): number => {
  switch (message.role) {
    case "user":
      return message.parts.reduce((sum, part) => sum + estimateTextTokens(textOfPart(part)), 0)
    case "assistant":
      return message.parts.reduce((sum, part) => sum + estimateTextTokens(textOfPart(part)), 0)
    case "system":
      return estimateTextTokens(message.text)
    case "compaction":
      return estimateTextTokens(message.text)
  }
}

const textOfPart = (part: Part): string => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text
    case "tool":
      return `${part.name} ${JSON.stringify(part.input ?? {})} ${toolOutputText(part)}`
    case "file":
      return `[附件 ${part.name ?? part.mime}]`
  }
}

const toolOutputText = (part: Extract<Part, { type: "tool" }>): string => {
  if (part.state.status === "success") return part.state.content.map((c) => (c.type === "text" ? c.text : "")).join("")
  if (part.state.status === "error") return part.state.error
  return "(未结算)"
}

/**
 * 把待压缩的消息渲染成纯文本对话稿。
 *
 * 这里不用 provider 原生的消息格式，原因是摘要请求只需要「内容」，
 * 用纯文本可以避免工具调用配对等协议约束带来的额外复杂度，
 * 也方便对超长工具输出做更激进的截断。
 */
const renderTranscript = (messages: Message[]): string =>
  messages
    .map((message) => {
      switch (message.role) {
        case "user":
          return `[用户]\n${message.parts.map(textOfPart).join("\n")}`
        case "assistant": {
          const parts = message.parts.map((part) => {
            if (part.type === "tool") {
              return `[工具调用 ${part.name}]\n入参：${JSON.stringify(part.input ?? {})}\n结果：${truncate(toolOutputText(part), TRANSCRIPT_TOOL_OUTPUT_LIMIT)}`
            }
            if (part.type === "reasoning") return ""
            return textOfPart(part)
          })
          return `[助手]\n${parts.filter(Boolean).join("\n")}`
        }
        case "system":
          return `[系统提示]\n${message.text}`
        case "compaction":
          return `[已有摘要]\n${message.text}`
      }
    })
    .join("\n\n")

const truncate = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.65)
  const tail = Math.max(limit - head, 0)
  return `${text.slice(0, head)}\n...（中间已截断，原长 ${text.length} 字符）...\n${text.slice(-tail)}`
}

/** 摘要请求的系统提示词。 */
const SUMMARY_SYSTEM_PROMPT = `你是一个 Coding Agent 的工作记忆压缩器，负责把较早对话整理成可供后续继续工作的结构化检查点。

要求：
- 只保留后续工作必需的信息，每条尽量使用单行短句。
- 保留原始目标、仍然有效的约束、已做出的决定、已完成和进行中的工作。
- 保留精确的文件路径、符号、命令、错误串和验证结果。
- 记录已经排除的方案和失败指纹，避免后续重复尝试。
- 丢弃寒暄、重复读取、已经作废的过程和模型推理。
- 摘要会被直接当作已发生的事实使用，不要写「根据对话」这类元描述。
- 不要编造；缺失的信息写「无」。

严格按以下格式输出（使用中文）：

## 目标
## 需求与限制
## 决定
## 已完成
## 进行中
## 阻塞
## 下一步
## 涉及的文件
## 关键上下文`

const SUMMARY_HEADINGS = [
  "## 目标",
  "## 需求与限制",
  "## 决定",
  "## 已完成",
  "## 进行中",
  "## 阻塞",
  "## 下一步",
  "## 涉及的文件",
  "## 关键上下文",
]

const SUMMARY_NUDGE = `你刚才的输出没有使用规定的模板。请重新输出完整摘要，必须使用上面的所有 ## 标题，不要解释，不要调用工具。`

const hasSummaryTemplate = (text: string): boolean =>
  SUMMARY_HEADINGS.every((heading) => text.includes(heading))

/** 摘要请求的用户消息。 */
const buildSummaryPrompt = (transcript: string, previousSummary?: string): string => {
  const sections: string[] = []
  if (previousSummary) {
    sections.push(["# 已有摘要", previousSummary, ""].join("\n"))
  }
  sections.push(
    [
      "# 待压缩的对话",
      transcript,
      "",
      "# 任务",
      previousSummary
        ? "把「已有摘要」与「待压缩的对话」合并成一份新摘要。新信息优先；已解决问题移出阻塞和进行中；保留未解决问题与仍然有效的决定。"
        : "把「待压缩的对话」整理成工作记忆摘要。",
    ].join("\n"),
  )
  return sections.join("\n")
}
