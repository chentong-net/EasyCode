import type { Message, Part, TaskState, ToolDefinition } from "@easycode/schema"
import { addUsage } from "@easycode/schema"

import type { CoreConfig } from "../config.js"
import { describeError, LLMError } from "../llm/error.js"
import type { LLMClient, LLMMessage, LLMRequest } from "../llm/types.js"
import { newMessageID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { estimateTextTokens } from "../util/token.js"
import {
  createCompactionBackupStore,
  type CompactionBackup,
  type SummaryBackupInput,
} from "./compaction-backup.js"
import { buildLLMMessages, selectHistoryMessages, estimateRequestTokens } from "./history.js"
import type { SessionHandle } from "./runtime.js"
import { taskMemorySummary } from "./task.js"

/**
 * 历史 compaction（压缩）。
 *
 * 触发条件和保留区都由上下文窗口动态推导：先扣除实际输出预算和安全余量，
 * 再按目标大小决定最近原文的保留量，避免固定参数在小窗口下互相冲突。
 *
 * 三个刻意的设计：
 *
 * 1. **用同一个模型做摘要**。不引入第二个模型意味着不需要额外配置，
 *    代价是摘要本身也消耗 token。摘要请求刻意不携带工具，避免模型
 *    在总结时又去调用工具。
 * 2. **按完整交换保留最近原文**。摘要会丢失细节（具体的行号、变量名），
 *    而接下来的工作恰恰最需要这些细节，因此保留区从用户消息开始。
 * 3. **分层降级**。摘要输入过大时先分块再合并；模型摘要不可用时生成
 *    基于任务状态记录的确定性 checkpoint（检查点），让任务仍能继续。
 */

/** 根据上下文窗口推导出的 compaction（压缩）预算，不再使用与窗口无关的固定值。 */
export interface CompactionBudget {
  contextWindow: number
  /** 为 provider 实际声明的输出预留，最多占窗口的四分之一。 */
  outputTokens: number
  /** 协议模板和估算误差的安全余量。 */
  safetyMargin: number
  /** 触发 provider 请求前的硬输入上限。 */
  hardInputTokens: number
  /** 达到该值时开始自动执行 compaction。 */
  triggerTokens: number
  /** compaction 后希望达到的目标大小。 */
  targetTokens: number
  /** compaction 后原样保留的最近原文，按估算 token 计 */
  keepTokens: number
  /** 摘要请求最多可以使用的输入 token。 */
  summaryInputTokens: number
  /** 摘要本身允许生成的最大 token。 */
  summaryOutputTokens: number
}

/** 摘要请求里单条工具结果的字符上限。compaction 的目的就是缩小体积，这里要更激进。 */
const TRANSCRIPT_TOOL_OUTPUT_LIMIT = 2_000

export type CompactionStatus = "skipped" | "completed" | "failed"

export interface CompactionOutcome {
  status: CompactionStatus
  reason: string
  beforeTokens?: number
  afterTokens?: number
  attempts: number
  usedFallback: boolean
  /** 诊断备份 ID，Runner 用它在最终请求重建后写入 after.json。 */
  backupID?: string
}

export interface CompactionDeps {
  config: CoreConfig
  llm: LLMClient
  logger?: Logger
}

export interface CompactInput {
  handle: SessionHandle
  /** 当前 epoch（上下文周期）的 baseline（基线）序号 */
  baselineSeq: number
  /** 本次请求的完整系统提示词（agent 提示词 + baseline） */
  system: string[]
  /** 本次请求的工具定义 */
  tools: ToolDefinition[]
  /** 本次请求的模型消息，用于估算占用 */
  messages: LLMMessage[]
  toolChoice?: "auto" | "none"
  signal?: AbortSignal
}

export interface CompactionManager {
  /** 当前会话窗口对应的预算，Runner 也使用其中的输出预留。 */
  budget(): CompactionBudget
  /** 估算当前请求的 token 占用 */
  estimate(system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number
  /** 必要时执行 compaction；调用方根据 completed 状态决定是否重建请求。 */
  compactIfNeeded(input: CompactInput): Promise<CompactionOutcome>
  /** 上下文超限后的强制 compaction。跳过节流判断，直接尝试。 */
  compactAfterOverflow(input: CompactInput): Promise<CompactionOutcome>
  /** 把最终重建、即将发送给主模型的请求写入 after.json。 */
  recordAfter(backupID: string | undefined, request: LLMRequest): Promise<void>
}

export const createCompactionManager = (deps: CompactionDeps): CompactionManager => {
  const logger = deps.logger ?? createLogger("session.compaction")
  const options = calculateCompactionBudget(deps.config)
  const backups = createCompactionBackupStore(deps.config.dataDir, logger)

  const estimate = (system: string[], messages: LLMMessage[], tools: ToolDefinition[]): number =>
    estimateRequestTokens(system, messages, tools)

  const compactIfNeeded = async (input: CompactInput): Promise<CompactionOutcome> => {
    const estimated = estimate(input.system, input.messages, input.tools)
    const last = input.handle.state.messages.at(-1)
    const afterCompaction = last?.role === "compaction"

    if (afterCompaction ? estimated <= options.hardInputTokens : estimated <= options.triggerTokens) {
      return { status: "skipped", reason: "context_fits", beforeTokens: estimated, attempts: 0, usedFallback: false }
    }

    logger.info("上下文接近上限，开始执行 compaction", {
      sessionID: input.handle.id,
      estimatedTokens: estimated,
      triggerTokens: options.triggerTokens,
      hardInputTokens: options.hardInputTokens,
      contextWindow: options.contextWindow,
    })

    return compact(input, "automatic", estimated)
  }

  const compactAfterOverflow = async (input: CompactInput): Promise<CompactionOutcome> => {
    logger.info("模型报告上下文超限，尝试执行 compaction 后重试", { sessionID: input.handle.id })
    return compact(input, "overflow", estimate(input.system, input.messages, input.tools))
  }

  const compact = async (
    input: CompactInput,
    reason: "automatic" | "overflow",
    beforeTokens: number,
  ): Promise<CompactionOutcome> => {
    const state = input.handle.state
    const messageID = newMessageID()
    await input.handle.append({
      type: "compaction.started",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      compactionID: messageID,
      reason,
      beforeTokens,
    })
    const backup = await backups.prepare({
      id: messageID,
      sessionID: input.handle.id,
      reason,
      model: state.session.model,
      baselineSeq: input.baselineSeq,
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      task: state.task,
      beforeTokens,
      budget: { ...options },
      ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
    })
    const history = selectHistoryMessages(state, input.baselineSeq)
    const targetTokens =
      reason === "overflow"
        ? Math.max(512, Math.min(options.targetTokens, Math.floor(beforeTokens * 0.7)))
        : options.targetTokens
    const keepTokens = Math.max(256, Math.min(options.keepTokens, Math.floor(targetTokens * 0.25)))
    const previous = history.find((message): message is Extract<Message, { role: "compaction" }> =>
      message.role === "compaction",
    )
    const candidates = history.filter((message) => message.role !== "compaction")
    const { head, tail } = splitHistory(candidates, keepTokens)

    if (head.length === 0 || tail.length === 0) {
      logger.warn("历史长度不足以执行 compaction，跳过", {
        sessionID: input.handle.id,
        head: head.length,
        tail: tail.length,
      })
      await backups.finalize(backup, {
        status: "failed",
        outcomeReason: "nothing_to_compact",
        summarizedMessages: head.length,
        keptMessages: tail.length,
      })
      await input.handle.append({
        type: "compaction.failed",
        sessionID: input.handle.id,
        timestamp: Date.now(),
        compactionID: messageID,
        reason: "nothing_to_compact",
      })
      return {
        status: "failed",
        reason: "nothing_to_compact",
        beforeTokens,
        attempts: 1,
        usedFallback: false,
        ...(backup ? { backupID: backup.id } : {}),
      }
    }

    // 已有 checkpoint（检查点）作为摘要输入，但不混入待 compaction 的消息和保留区。
    const subject = head

    const summarized = await summarize({ ...input, previousSummary: previous?.text }, subject, backup)
    if (!summarized && input.signal?.aborted) {
      await backups.finalize(backup, {
        status: "failed",
        outcomeReason: "aborted",
        summarizedMessages: subject.length,
        keptMessages: tail.length,
      })
      await input.handle.append({
        type: "compaction.failed",
        sessionID: input.handle.id,
        timestamp: Date.now(),
        compactionID: messageID,
        reason: "aborted",
      })
      return {
        status: "failed",
        reason: "aborted",
        beforeTokens,
        attempts: 1,
        usedFallback: false,
        ...(backup ? { backupID: backup.id } : {}),
      }
    }

    const summary =
      summarized?.text ??
      buildFallbackSummary(input.handle.state.task, subject, tail, options.summaryOutputTokens)
    const usedFallback = summarized === undefined
    const attempts = summarized?.attempts ?? 1
    if (usedFallback) {
      logger.warn("模型摘要不可用，使用任务状态记录生成确定性 checkpoint（检查点）", {
        sessionID: input.handle.id,
        summarizedMessages: subject.length,
      })
    }

    await input.handle.append({
      type: "compaction.ended",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      messageID,
      text: summary,
      recentMessageIDs: tail.map((message) => message.id),
      reason: usedFallback ? "fallback" : reason === "overflow" ? "overflow" : "automatic",
      beforeTokens,
      attempts,
      usedFallback,
    })

    const afterMessages = buildLLMMessages(input.handle.state, { baselineSeq: input.baselineSeq })
    const afterTokens = estimate(input.system, afterMessages, input.tools)

    logger.info("compaction 完成", {
      sessionID: input.handle.id,
      summarizedMessages: subject.length,
      keptMessages: tail.length,
      keptTokens: estimateMessagesTokens(tail),
      summaryChars: summary.length,
      beforeTokens,
      afterTokens,
      triggerTokens: options.triggerTokens,
      hardInputTokens: options.hardInputTokens,
    })
    if (afterTokens > options.triggerTokens) {
      logger.warn("compaction 后仍高于软阈值，下一轮将继续收缩", {
        sessionID: input.handle.id,
        afterTokens,
        triggerTokens: options.triggerTokens,
      })
    }
    const outcomeReason = usedFallback
      ? "fallback_checkpoint"
      : reason === "overflow"
        ? "overflow_compacted"
        : "automatic_compacted"
    await backups.finalize(backup, {
      status: "completed",
      outcomeReason,
      summarizedMessages: subject.length,
      keptMessages: tail.length,
      keptTokens: estimateMessagesTokens(tail),
      summaryChars: summary.length,
      estimatedAfterTokens: afterTokens,
      attempts,
      usedFallback,
      checkpointMessageID: messageID,
    })
    return {
      status: "completed",
      reason: outcomeReason,
      beforeTokens,
      afterTokens,
      attempts,
      usedFallback,
      ...(backup ? { backupID: backup.id } : {}),
    }
  }

  const summarize = async (
    input: CompactInput & { previousSummary?: string },
    subject: Message[],
    backup: CompactionBackup | undefined,
  ): Promise<{ text: string; attempts: number } | undefined> => {
    const transcript = renderTranscript(subject)
    const available =
      options.summaryInputTokens - estimateTextTokens(SUMMARY_SYSTEM_PROMPT) - 64
    if (available < 256) return undefined
    const previousSummary =
      input.previousSummary === undefined
        ? undefined
        : truncateToTokenBudget(input.previousSummary, Math.floor(available * 0.25))
    const taskMemory = truncateToTokenBudget(
      taskMemorySummary(input.handle.state.task),
      Math.max(128, Math.floor(available * 0.2)),
    )
    const prompt = buildSummaryPrompt(transcript, previousSummary, taskMemory)
    let attempts = 0

    const run = async (
      userPrompt: string,
      purpose: SummaryBackupInput["purpose"],
    ): Promise<{ text: string; finish: string; attempts: number } | undefined> => {
      let text = ""
      let finish = ""
      let usage = undefined as Parameters<typeof addUsage>[0] | undefined
      let attemptsUsed = 0

      for (let callAttempt = 1; callAttempt <= 2; callAttempt += 1) {
        attemptsUsed = callAttempt
        text = ""
        finish = ""
        const request: LLMRequest = {
          model: input.handle.state.session.model,
          system: [SUMMARY_SYSTEM_PROMPT],
          messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
          // 摘要请求不带工具：避免模型在总结时又去调用工具
          tools: [],
          maxOutputTokens: options.summaryOutputTokens,
          sessionID: input.handle.id,
          ...(input.signal ? { signal: input.signal } : {}),
        }
        try {
          for await (const event of deps.llm.stream(request)) {
            if (event.type === "text.delta") text += event.text
            if (event.type === "usage") usage = event.usage
            if (event.type === "finish") finish = event.reason
          }
          await backups.recordSummary(backup, {
            purpose: callAttempt === 1 ? purpose : "retry",
            request,
            response: {
              text,
              finish,
              usage,
              validTemplate: hasSummaryTemplate(text),
              keepText:
                purpose === "chunk" ||
                finish === "length" ||
                text.trim().length === 0 ||
                !hasSummaryTemplate(text),
            },
          })
          break
        } catch (error) {
          await backups.recordSummary(backup, {
            purpose: callAttempt === 1 ? purpose : "retry",
            request,
            response: {
              text,
              finish,
              usage,
              validTemplate: false,
              error: describeError(error),
              keepText: true,
            },
          })
          if (
            callAttempt === 1 &&
            error instanceof LLMError &&
            error.retryable &&
            input.signal?.aborted !== true
          ) {
            logger.warn("摘要请求暂时失败，准备重试", {
              sessionID: input.handle.id,
              kind: error.kind,
            })
            try {
              await delay(500, input.signal)
            } catch {
              return undefined
            }
            continue
          }
          logger.warn("摘要请求失败，本次不执行 compaction", {
            sessionID: input.handle.id,
            error: describeError(error),
          })
          return undefined
        }
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
      return { text: text.trim(), finish, attempts: attemptsUsed }
    }

    const valid = async (
      userPrompt: string,
      purpose: SummaryBackupInput["purpose"],
    ): Promise<string | undefined> => {
      const first = await run(userPrompt, purpose)
      attempts += first?.attempts ?? 1
      if (!first || first.finish === "length" || first.text.length === 0) return undefined
      if (hasSummaryTemplate(first.text)) return first.text

      const corrected = await run(`${userPrompt}\n\n${SUMMARY_NUDGE}`, "corrected")
      attempts += corrected?.attempts ?? 1
      if (!corrected || corrected.finish === "length" || corrected.text.length === 0) return undefined
      return hasSummaryTemplate(corrected.text) ? corrected.text : undefined
    }

    const fits = (value: string): boolean => estimateTextTokens(value) < available
    if (fits(prompt)) {
      const summary = await valid(prompt, "initial")
      return summary ? { text: summary, attempts } : undefined
    }

    const chunks = splitMessagesForSummary(subject, Math.max(512, Math.floor(available * 0.75)))
    if (chunks.length === 0 || chunks.length > 8) {
      logger.warn("待执行 compaction 的历史无法稳定分块", { sessionID: input.handle.id, chunks: chunks.length })
      return undefined
    }

    const parts: string[] = []
    for (const chunk of chunks) {
      const chunkPrompt = buildSummaryPrompt(
        truncateToTokenBudget(renderTranscript(chunk), Math.floor(available * 0.9)),
      )
      const part = await valid(chunkPrompt, "chunk")
      if (!part) return undefined
      parts.push(part)
    }
    if (parts.length === 1) return { text: parts[0] as string, attempts }

    const mergedTranscript = parts.join("\n\n---\n\n")
    const mergePrompt = buildSummaryPrompt(
      truncateToTokenBudget(mergedTranscript, Math.floor(available * 0.9)),
      previousSummary,
      taskMemory,
    )
    const merged = await valid(mergePrompt, "merge")
    return merged ? { text: merged, attempts } : undefined
  }

  const recordAfter = async (backupID: string | undefined, request: LLMRequest): Promise<void> => {
    await backups.recordAfter(
      backupID,
      request,
      estimate(request.system, request.messages, request.tools),
    )
  }

  return {
    budget: () => ({ ...options }),
    estimate,
    compactIfNeeded,
    compactAfterOverflow,
    recordAfter,
  }
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

const splitMessagesForSummary = (messages: Message[], budget: number): Message[][] => {
  const chunks: Message[][] = []
  let current: Message[] = []
  let used = 0

  for (const message of messages) {
    const size = estimateMessageTokens(message)
    if (current.length > 0 && used + size > budget) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(message)
    used += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const truncateToTokenBudget = (text: string, budget: number): string => {
  const estimated = estimateTextTokens(text)
  if (estimated <= budget) return text
  const ratio = Math.max(0.05, budget / Math.max(estimated, 1))
  return truncate(text, Math.max(200, Math.floor(text.length * ratio)))
}

const delay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error("已取消"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

/**
 * 模型摘要不可用时仍生成可继续工作的 checkpoint（检查点）。它可能损失过程细节，但会保留
 * 任务契约、最近用户请求、修改文件、失败和验证状态。
 */
const buildFallbackSummary = (
  task: TaskState | undefined,
  subject: Message[],
  tail: Message[],
  maxTokens: number,
): string => {
  const messages = [...subject, ...tail]
  const users = messages
    .filter((message): message is Extract<Message, { role: "user" }> => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))
    .slice(-3)
  const failures = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.flatMap((part) =>
          part.type === "tool" && part.state.status === "error" ? [part.state.error] : [],
        )
      : [],
  )
  const verifications = task?.verifications.slice(-5) ?? []
  const lines = [
    "## 目标",
    task?.contract.goal || users.at(-1) || "无",
    "",
    "## 需求与限制",
    ...(task?.contract.constraints.length ? task.contract.constraints.map((item) => `- ${item}`) : ["- 无"]),
    "",
    "## 决定",
    `- 使用确定性降级 checkpoint（检查点）继续任务。`,
    "",
    "## 已完成",
    `- 已保留 ${users.length} 条最近用户请求。`,
    "",
    "## 进行中",
    `- 当前阶段：${task?.phase ?? "未知"}`,
    ...(users.length ? [`- 最近请求：${users.at(-1)}`] : []),
    "",
    "## 阻塞",
    ...(failures.length ? failures.slice(-3).map((item) => `- ${item}`) : ["- 无"]),
    "",
    "## 下一步",
    "- 根据最近的用户请求继续工作。",
    "- 若已经修改代码，先执行相关验证。",
    "",
    "## 涉及的文件",
    ...(task?.changedPaths.length ? task.changedPaths.map((path) => `- ${path}`) : ["- 无"]),
    "",
    "## 关键上下文",
    ...(verifications.length
      ? verifications.map((item) => `- 验证 ${item.status}：${item.summary}`)
      : [`- 验证状态：${task?.verificationStatus ?? "unknown"}`]),
    "",
    "## 任务状态",
    taskMemorySummary(task),
  ]
  return truncateToTokenBudget(lines.join("\n"), maxTokens)
}

/**
 * 把历史按「保留最近一段原文」切成两段。
 *
 * 从尾部往前累加估算 token，直到超过 keepTokens 为止，那之前的全部进 head。
 * 至少要保留一条消息在 tail 里：如果连最后一条都被算进 head，
 * 执行 compaction 后模型会完全失去最近发生的事情。
 */
const splitHistory = (history: Message[], keepTokens: number): { head: Message[]; tail: Message[] } => {
  if (history.length === 0) return { head: [], tail: [] }

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

  // 尽可能从用户消息开始保留交换，但只有仍在预算内时才这样做。Coding Agent
  // 的一个用户请求可能包含几十个 provider turn（模型调用轮次），不能因此让整个任务都变成保留区。
  if (splitIndex > 0 && splitIndex < history.length) {
    for (let index = splitIndex; index >= 0; index -= 1) {
      if (history[index]?.role === "user") {
        if (estimateMessagesTokens(history.slice(index)) <= keepTokens) splitIndex = index
        break
      }
    }
  }

  // 至少保留最后一条消息，同时确保还有可摘要的历史。单个超长交换必须在
  // 助手消息边界内切分；原始用户目标由独立任务状态继续携带。
  splitIndex = Math.min(splitIndex, history.length - 1)
  if (splitIndex === 0 && history.length > 1) splitIndex = 1

  return { head: history.slice(0, splitIndex), tail: history.slice(splitIndex) }
}

const estimateMessagesTokens = (messages: Message[]): number =>
  messages.reduce((total, message) => total + estimateMessageTokens(message), 0)

/** 估算单条消息的体积，用于决定 compaction 边界。 */
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
      return part.text
    case "reasoning":
      return ""
    case "tool":
      return `${part.name} ${JSON.stringify(part.input ?? {})} ${toolOutputText(part)}`
    case "file":
      return `[附件 ${part.name ?? part.mime}]`
  }
}

const toolOutputText = (part: Extract<Part, { type: "tool" }>): string => {
  if (part.state.status === "success") return part.state.content.map((c) => (c.type === "text" ? c.text : "")).join("")
  if (part.state.status === "error") return part.state.error
  return "(尚未完成)"
}

/**
 * 把待执行 compaction 的消息渲染成纯文本对话稿。
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
const SUMMARY_SYSTEM_PROMPT = `你是一个 Coding Agent 的工作记忆压缩器，负责把较早对话整理成可供后续继续工作的结构化 checkpoint（检查点）。

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
const buildSummaryPrompt = (
  transcript: string,
  previousSummary?: string,
  taskMemory?: string,
): string => {
  const sections: string[] = []
  if (previousSummary) {
    sections.push(["# 已有摘要", previousSummary, ""].join("\n"))
  }
  if (taskMemory) {
    sections.push(["# 当前任务状态", taskMemory, ""].join("\n"))
  }
  sections.push(
    [
      "# 待执行 compaction 的对话",
      transcript,
      "",
      "# 任务",
      previousSummary
        ? "把「已有摘要」与「待执行 compaction 的对话」合并成一份新摘要。新信息优先；已解决问题移出阻塞和进行中；保留未解决问题与仍然有效的决定。"
        : "把「待执行 compaction 的对话」整理成工作记忆摘要。",
    ].join("\n"),
  )
  return sections.join("\n")
}
