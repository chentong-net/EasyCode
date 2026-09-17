import type { Message, Part, ToolDefinition } from "@easycode/schema"
import { addUsage } from "@easycode/schema"

import type { CoreConfig } from "../config.js"
import { describeError } from "../llm/error.js"
import type { LLMClient, LLMMessage } from "../llm/types.js"
import { newMessageID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { estimateTextTokens } from "../util/token.js"
import { selectHistoryMessages, estimateRequestTokens } from "./history.js"
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

/** 压缩配置。数值来自实测经验，也可以理解为「给模型留多少余量」的旋钮。 */
export interface CompactionOptions {
  /** 上下文窗口大小 */
  contextWindow: number
  /** 输出预算，压缩阈值至少要为它留出空间 */
  maxOutputTokens: number
  /** 缓冲区：额外预留的余量，避免在临界点反复压缩 */
  bufferTokens: number
  /** 压缩后原样保留的最近原文，按估算 token 计 */
  keepTokens: number
}

export const DEFAULT_BUFFER_TOKENS = 20_000
export const DEFAULT_KEEP_TOKENS = 8_000

/** 摘要请求里单条工具结果的字符上限。压缩的目的就是缩小体积，这里要更激进。 */
const TRANSCRIPT_TOOL_OUTPUT_LIMIT = 2_000

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
  /** 估算当前请求的 token 占用 */
  estimate(system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number
  /**
   * 必要时压缩。返回 true 表示已经压缩，调用方必须重新读取历史、重建请求。
   * 返回 false 表示无需压缩，或压缩尝试失败（状态未被改动）。
   */
  compactIfNeeded(input: CompactInput): Promise<boolean>
  /** 上下文超限后的强制压缩。跳过节流判断，直接尝试。 */
  compactAfterOverflow(input: CompactInput): Promise<boolean>
}

export const createCompactionManager = (deps: CompactionDeps): CompactionManager => {
  const logger = deps.logger ?? createLogger("session.compaction")
  const options: CompactionOptions = {
    contextWindow: deps.config.contextWindow,
    maxOutputTokens: deps.config.maxOutputTokens,
    bufferTokens: DEFAULT_BUFFER_TOKENS,
    keepTokens: DEFAULT_KEEP_TOKENS,
  }

  const estimate = (system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number =>
    estimateRequestTokens(system, messages, tools)

  const compactIfNeeded = async (input: CompactInput): Promise<boolean> => {
    const estimated = estimate(input.system, input.messages, input.tools)
    // 输出预算与缓冲区取较大值：两者都要用上下文空间，谁大谁就是真正的约束
    const limit = options.contextWindow - Math.max(options.maxOutputTokens, options.bufferTokens)

    if (estimated <= limit) return false

    logger.info("上下文接近上限，开始压缩", {
      sessionID: input.handle.id,
      estimatedTokens: estimated,
      limit,
      contextWindow: options.contextWindow,
    })

    return compact(input)
  }

  const compactAfterOverflow = async (input: CompactInput): Promise<boolean> => {
    logger.info("模型报告上下文超限，尝试压缩后重试", { sessionID: input.handle.id })
    return compact(input)
  }

  const compact = async (input: CompactInput): Promise<boolean> => {
    const state = input.handle.state
    const history = selectHistoryMessages(state, input.baselineSeq)
    const { head, tail } = splitHistory(history, options.keepTokens)

    if (head.length === 0 || tail.length === 0) {
      logger.warn("历史长度不足以压缩，跳过", { sessionID: input.handle.id, head: head.length, tail: tail.length })
      return false
    }

    // 如果 head 里已经存在上一次的检查点，把它的摘要作为「已有摘要」传进去做增量合并，
    // 避免每次都从零总结导致早期信息被逐次稀释
    const previous = head.find((message): message is Extract<Message, { role: "compaction" }> =>
      message.role === "compaction",
    )
    const subject = previous ? head.filter((message) => message !== previous) : head

    const summary = await summarize({ ...input, previousSummary: previous?.text }, subject)
    if (summary === undefined) return false

    await input.handle.append({
      type: "compaction.ended",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      messageID: newMessageID(),
      text: summary,
      recentMessageIDs: tail.map((message) => message.id),
    })

    logger.info("压缩完成", {
      sessionID: input.handle.id,
      summarizedMessages: subject.length,
      keptMessages: tail.length,
      summaryChars: summary.length,
    })
    return true
  }

  const summarize = async (
    input: CompactInput & { previousSummary?: string },
    subject: Message[],
  ): Promise<string | undefined> => {
    const transcript = renderTranscript(subject)
    const prompt = buildSummaryPrompt(transcript, input.previousSummary)

    // 摘要请求本身要足够小，否则它会自己撞上上下文限制
    const promptTokens = estimateTextTokens(prompt) + estimateTextTokens(SUMMARY_SYSTEM_PROMPT)
    const available = options.contextWindow - options.maxOutputTokens
    if (promptTokens >= available) {
      logger.warn("待压缩内容过大，摘要请求本身就会超限，已放弃本次压缩", {
        sessionID: input.handle.id,
        promptTokens,
        available,
      })
      return undefined
    }

    let text = ""
    let finish = ""
    let usage = undefined as Parameters<typeof addUsage>[0] | undefined

    try {
      for await (const event of deps.llm.stream({
        model: input.handle.state.session.model,
        system: [SUMMARY_SYSTEM_PROMPT],
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        // 摘要请求不带工具：避免模型在总结时又去调用工具
        tools: [],
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

    const trimmed = text.trim()
    if (trimmed.length === 0) {
      logger.warn("摘要结果为空，本次不压缩", { sessionID: input.handle.id, finish })
      return undefined
    }

    return trimmed
  }

  return { estimate, compactIfNeeded, compactAfterOverflow }
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
            if (part.type === "reasoning") return `[思考]\n${part.text}`
            return textOfPart(part)
          })
          return `[助手]\n${parts.join("\n")}`
        }
        case "system":
          return `[系统提示]\n${message.text}`
        case "compaction":
          return `[已有摘要]\n${message.text}`
      }
    })
    .join("\n\n")

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n...（已截断，原长 ${text.length} 字符）`

/** 摘要请求的系统提示词。 */
const SUMMARY_SYSTEM_PROMPT = `你是一个对话压缩助手，负责把长对话压缩成结构化摘要，供后续继续工作使用。

要求：
- 保留对后续工作有用的全部信息：用户目标、已达成的决定、已完成的改动、当前状态、未解决的问题、涉及的文件与关键位置。
- 丢弃寒暄、重复的尝试过程、已经作废的方案。
- 摘要会被直接当作已发生的事实使用，因此不要写「根据对话」这类元描述，直接陈述结论。
- 缺失的信息写「无」，不要编造。

严格按以下格式输出（使用中文）：

## 目标
## 关键信息
## 已完成
## 进行中
## 阻塞
## 下一步
## 涉及的文件`

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
        ? "把「已有摘要」与「待压缩的对话」合并成一份新摘要：新信息优先；已完成的工作从「进行中」移到「已完成」；同一件事不要重复描述。"
        : "把「待压缩的对话」压缩成一份摘要。",
    ].join("\n"),
  )
  return sections.join("\n")
}
