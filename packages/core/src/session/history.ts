import type { Content, Message, Part, ToolDefinition } from "@easycode/schema"

import type { LLMMessage } from "../llm/types.js"
import { createLogger } from "../log.js"
import { estimateTextTokens, MESSAGE_OVERHEAD_TOKENS, TOOL_OVERHEAD_TOKENS } from "../util/token.js"
import type { ProjectedState } from "./projector.js"
import { renderTaskState } from "./task.js"

const logger = createLogger("session.history")

/**
 * 历史投影：把投影出来的消息转换成发给模型的消息数组。
 *
 * 这里要处理四件事，每一件都对应一个真实会踩到的坑：
 *
 * 1. **压缩点裁剪**：压缩之后，压缩点之前的消息只保留被显式保留的最近若干条，
 *    其余全部丢弃，由检查点消息代替。
 * 2. **纪元裁剪**：序号不大于 baselineSeq 的系统消息已经被折进 baseline，
 *    必须从历史里剔除，否则模型会看到重复或过时的上下文说明。
 * 3. **工具调用配对**：本地工具在助手消息里是 tool_call，结果必须作为独立的
 *    tool 消息紧跟其后。任何一条 tool_call 缺少对应结果，OpenAI 都会直接报错，
 *    因此未结算的调用要补一条「无结果」的说明。
 * 4. **推理内容不回流**：推理文本保留在投影里供 UI 展示，但绝不发回模型。
 *    部分推理模型（如 DeepSeek）明确要求不要回传 reasoning 字段，
 *    把历史里的推理内容带回去会导致请求被拒绝。
 */

export interface HistoryOptions {
  /** 当前纪元的 baseline 序号，用于过滤已折进 baseline 的系统消息 */
  baselineSeq: number
}

/** 把投影状态转换成发给模型的消息数组。 */
export const buildLLMMessages = (state: ProjectedState, options: HistoryOptions): LLMMessage[] => {
  const selected = selectHistoryMessages(state, options.baselineSeq)
  const result: LLMMessage[] = []

  for (const message of selected) {
    switch (message.role) {
      case "user":
        result.push({ role: "user", content: toUserContent(message) })
        break

      case "system":
        result.push({ role: "system", text: message.text })
        break

      case "compaction":
        result.push({ role: "user", content: [{ type: "text", text: checkpointText(message.text) }] })
        break

      case "assistant": {
        const text = joinTextParts(message)
        // 用类型谓词而不是普通过滤：普通过滤只能得到 Part[]，
        // 后续取 callID / name 时类型就丢了
        const toolParts = message.parts.filter(
          (part): part is Extract<Part, { type: "tool" }> => part.type === "tool" && part.callID.length > 0,
        )

        // 既没有文本也没有工具调用的助手消息会被协议层丢弃，
        // 这里提前跳过可以避免为它生成一条孤立的 tool 消息
        if (text.length === 0 && toolParts.length === 0) break

        result.push({
          role: "assistant",
          text,
          toolCalls: toolParts.map((part) => ({
            callID: part.callID,
            name: part.name,
            // 入参为空的工具（例如无参工具）要用空对象而不是 undefined，
            // 否则序列化出去会变成字符串 "null"，在部分实现上会被判为非法入参
            input: part.input ?? {},
          })),
        })

        for (const part of toolParts) {
          result.push({ role: "tool", callID: part.callID, content: toolResultContent(part) })
        }
        break
      }
    }
  }

  // 任务记忆放在动态历史尾部：它每次可能变化，但不会破坏系统提示词前缀缓存。
  if (state.task) result.push({ role: "system", text: renderTaskState(state.task) })

  return result
}

/**
 * 挑选进入模型历史的消息。
 *
 * 顺序规则：最新检查点 → 检查点之前被显式保留的消息 → 检查点之后的所有消息。
 * 「被保留的消息」按原始顺序排列，因为它们与检查点之后的对话是同一段连续历史。
 *
 * 压缩逻辑也复用这个函数：它必须和「真正发给模型的消息」保持一致，
 * 否则会出现「压缩时以为某条消息在历史里、实际却没发出去」这种错位。
 */
export const selectHistoryMessages = (state: ProjectedState, baselineSeq: number): Message[] => {
  const messages = state.messages
  let compactionIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "compaction") {
      compactionIndex = index
      break
    }
  }

  let selected: Message[]
  if (compactionIndex === -1) {
    selected = [...messages]
  } else {
    const compaction = messages[compactionIndex]
    if (!compaction || compaction.role !== "compaction") return []
    const kept = new Set(compaction.recentMessageIDs)
    selected = [
      compaction,
      ...messages.slice(0, compactionIndex).filter((message) => kept.has(message.id)),
      ...messages.slice(compactionIndex + 1),
    ]
  }

  return selected.filter((message) => {
    if (message.role !== "system") return true
    const seq = state.messageSeq.get(message.id) ?? 0
    return seq > baselineSeq
  })
}

/** 用户消息的内容块：文本与图片原样传递。 */
const toUserContent = (message: Extract<Message, { role: "user" }>): Content[] =>
  message.parts.flatMap((part): Content[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }]
    if (part.type === "file") {
      return [{ type: "file", mime: part.mime, data: part.data, ...(part.name ? { name: part.name } : {}) }]
    }
    // 用户消息里出现工具或推理 part 属于异常情况，忽略即可
    return []
  })

/** 拼接助手消息里的全部文本 part。 */
const joinTextParts = (message: Extract<Message, { role: "assistant" }>): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")

/** 把工具结果转成 tool 消息的内容。 */
const toolResultContent = (part: Extract<Part, { type: "tool" }>): Content[] => {
  if (part.state.status === "success") {
    return part.state.content.length > 0 ? part.state.content : [{ type: "text", text: "（工具执行完成，没有输出）" }]
  }
  if (part.state.status === "error") {
    return [{ type: "text", text: `工具执行失败：${part.state.error}` }]
  }
  // 走到这里说明调用还处于 pending：要么正在等待用户审批，要么上一轮进程被中断。
  // 必须补一条结果消息，否则 tool_call 找不到配对会让整个请求被服务端拒绝。
  logger.warn("历史中存在未结算的工具调用，已补写占位结果", { callID: part.callID, name: part.name })
  return [{ type: "text", text: "（该工具调用没有返回结果，可能被中断或仍在等待审批）" }]
}

/** 压缩检查点的包装文本。用明确的标签把摘要与普通对话区分开。 */
export const checkpointText = (summary: string): string =>
  [
    "<conversation-checkpoint>",
    "以下是更早对话的摘要。原始消息已被压缩，请把摘要当作已经发生的事实。",
    "",
    summary,
    "</conversation-checkpoint>",
  ].join("\n")

/**
 * 估算一次请求的 token 总量。
 *
 * 用于判断是否需要压缩，以及给 UI 显示上下文占用。
 * 刻意不包含真实 usage（那要等响应回来才有），因此总是在请求发出之前计算。
 */
export const estimateRequestTokens = (
  system: string[],
  messages: LLMMessage[],
  tools: ToolDefinition[],
): number => {
  let total = system.reduce((sum, part) => sum + estimateTextTokens(part), 0)

  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    switch (message.role) {
      case "system":
        total += estimateTextTokens(message.text)
        break
      case "user":
      case "tool":
        total += message.content.reduce(
          (sum, part) => sum + (part.type === "text" ? estimateTextTokens(part.text) : estimateTextTokens(part.data)),
          0,
        )
        break
      case "assistant":
        total += estimateTextTokens(message.text)
        for (const call of message.toolCalls) {
          total += TOOL_OVERHEAD_TOKENS
          total += estimateTextTokens(call.name)
          total += estimateTextTokens(JSON.stringify(call.input ?? {}))
        }
        break
    }
  }

  for (const tool of tools) {
    total += TOOL_OVERHEAD_TOKENS + estimateTextTokens(tool.description) + estimateTextTokens(JSON.stringify(tool.parameters))
  }

  return total
}
