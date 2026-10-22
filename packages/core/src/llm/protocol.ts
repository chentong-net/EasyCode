import type { Content, ToolDefinition, Usage } from "@easycode/schema"

import { newToolCallID } from "../id.js"
import { classifyHTTPError, describeError, LLMError } from "./error.js"
import type { LLMEvent, LLMMessage, LLMRequest } from "./types.js"

/**
 * OpenAI Chat Completions 协议的编解码。
 *
 * 这个文件里全是纯函数与纯状态机，不碰网络，因此可以单独测试：
 * 「给定一段历史，报文长什么样」「给定一段 chunk 序列，产出哪些事件」。
 * 把这个边界划清楚，是为了让将来接第二家 provider 时只需新增一个同形状的文件。
 */

/* -------------------------------------------------------------------------- */
/* 报文形状（只声明我们真正读写的字段）                                          */
/* -------------------------------------------------------------------------- */

type OpenAIRequestContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIRequestContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCallPayload[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface OpenAIToolCallPayload {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** 流式响应中的一个 chunk。 */
interface ChatChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      /** DeepSeek 等实现使用的字段名 */
      reasoning_content?: string | null
      /** 部分网关使用的字段名 */
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: RawUsage
  error?: { message?: string; code?: string; type?: string }
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/* -------------------------------------------------------------------------- */
/* 请求构造                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 构造 Chat Completions 的请求体。
 *
 * 两个刻意的取舍：
 *
 * 1. 发送 `stream_options.include_usage`。不加这个字段时，OpenAI 的流式响应
 *    不会返回 usage，而且**不会报错**——用量统计会静默地永远是 0。
 * 2. 只有调用方明确传入输出预算时才发送 max_tokens。多数 OpenAI 兼容实现
 *    支持该字段；不传时仍然保留 provider 默认行为。
 */
export const buildRequestBody = (request: LLMRequest): Record<string, unknown> => {
  const messages: OpenAIMessage[] = []
  const system = request.system.filter((part) => part.length > 0)
  if (system.length > 0) messages.push({ role: "system", content: system.join("\n\n") })
  messages.push(...toOpenAIMessages(request.messages))

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (request.tools.length > 0) {
    body.tools = toOpenAITools(request.tools)
    body.tool_choice = request.toolChoice ?? "auto"
  }

  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens

  return body
}

/** 把归一化消息转换成 OpenAI 的 messages 数组。 */
export const toOpenAIMessages = (messages: LLMMessage[]): OpenAIMessage[] => {
  const result: OpenAIMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case "system":
        result.push({ role: "system", content: message.text })
        break

      case "user":
        result.push({ role: "user", content: toUserContent(message.content) })
        break

      case "assistant": {
        // 空文本且没有工具调用的助手消息必须丢弃：模型的上下文里出现
        // 一条完全空白的助手发言会让部分实现直接报错
        if (message.text.length === 0 && message.toolCalls.length === 0) break
        result.push({
          role: "assistant",
          content: message.text.length > 0 ? message.text : null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.callID,
                  type: "function" as const,
                  function: {
                    name: call.name,
                    arguments: typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
                  },
                })),
              }
            : {}),
        })
        break
      }

      case "tool":
        result.push({ role: "tool", tool_call_id: message.callID, content: toToolContent(message.content) })
        break
    }
  }

  return result
}

/** 用户消息的内容：纯文本走字符串形式（兼容性最好），含附件时走内容数组。 */
const toUserContent = (content: Content[]): string | OpenAIRequestContentPart[] => {
  if (content.every((part) => part.type === "text")) {
    return content.map((part) => part.text).join("\n\n")
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image_url" as const, image_url: { url: `data:${part.mime};base64,${part.data}` } },
  )
}

/**
 * 工具结果的内容。
 *
 * 工具消息只发送文本：多数实现不支持工具消息里带图片，塞进去会导致 400。
 * 出现文件块时降级成一行文字说明，避免信息被静默丢弃。
 */
const toToolContent = (content: Content[]): string =>
  content
    .map((part) => (part.type === "text" ? part.text : `[附件 ${part.name ?? part.mime} 已省略：工具结果暂不支持二进制内容]`))
    .join("\n")

/** 把工具定义转换成 OpenAI 的 function 声明。 */
export const toOpenAITools = (tools: ToolDefinition[]): Array<Record<string, unknown>> =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

/* -------------------------------------------------------------------------- */
/* 用量换算                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 把 provider 的 usage 字段换算成统一语义。
 *
 * 语义约定（与 @easycode/schema 的 Usage 保持一致）：
 * - `input` 只统计未命中缓存的输入 token，`cacheRead` 单独计，两者互不重叠，相加才是输入总量。
 *   这样做的原因是各家实现把缓存 token 有的算进 prompt_tokens、有的单列，统一成互不重叠更安全。
 * - `output` 是模型生成的**总量**，其中**包含** reasoning token（OpenAI 的语义如此），
 *   所以展示总输出时不应该把 reasoning 再加一遍。
 * - `cacheWrite` 只有 Anthropic 系的接口会返回，OpenAI 兼容协议下恒为 0。
 */
export const mapUsage = (raw: RawUsage | undefined): Usage => {
  const promptTokens = toNumber(raw?.prompt_tokens)
  const cachedTokens = toNumber(raw?.prompt_tokens_details?.cached_tokens)

  return {
    input: Math.max(promptTokens - cachedTokens, 0),
    output: toNumber(raw?.completion_tokens),
    reasoning: toNumber(raw?.completion_tokens_details?.reasoning_tokens),
    cacheRead: cachedTokens,
    cacheWrite: 0,
  }
}

const toNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/* -------------------------------------------------------------------------- */
/* 流式解码                                                                     */
/* -------------------------------------------------------------------------- */

export interface DecoderResult {
  events: LLMEvent[]
  /**
   * 是否已经收到 `[DONE]`，消费方可以停止读取。
   *
   * 注意它**不**代表「已经产出 finish 事件」：OpenAI 在开启
   * stream_options.include_usage 后，会把用量单独放在 finish_reason 之后的
   * 那一帧里。如果收到 finish 就停止读取，usage 会永远是 0，
   * 而且不会报任何错——这正是最难发现的一类问题。
   */
  done: boolean
}

export interface StreamDecoder {
  /** 处理一个 SSE data 载荷 */
  push(payload: string): DecoderResult
  /** 流意外结束（例如连接被切断）时调用，把尚未产出的工具调用和 finish 事件吐出来 */
  finalize(): LLMEvent[]
}

interface PendingToolCall {
  callID: string
  name: string
  /** 分片到达的 JSON 参数字符串，需要全部拼完才能解析 */
  args: string
}

/**
 * 创建流式解码器。
 *
 * 工具调用的参数是**分片到达**的：模型先给 id 和函数名，之后一次几字节地吐 JSON。
 * 只有等流结束（finish_reason 或 [DONE]）才能拿到完整的 JSON 去解析，
 * 因此这里必须累积，不能在收到第一个分片时就产出 tool.call 事件。
 *
 * `finished` 与 `done` 是两个不同的状态，不能合并：
 * - `finished`：finish 事件已经产出，之后不会再有工具调用需要写入最终结果
 * - `done`：收到 `[DONE]`，流可以停止读取
 * 用量帧夹在两者之间，把它们混为一谈会导致用量统计静默归零。
 */
export const createStreamDecoder = (): StreamDecoder => {
  const pending = new Map<number, PendingToolCall>()
  let finished = false
  let lastFinishReason = ""
  let textCarry = ""
  let dsmlBuffer = ""
  let inDsml = false
  let dsmlCallsDetected = false

  const flushToolCalls = (): LLMEvent[] => {
    const events = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => toToolCallEvent(call))
    pending.clear()
    return events
  }

  const completeDsml = (): { events: LLMEvent[]; hasCalls: boolean } => {
    const block = dsmlBuffer
    dsmlBuffer = ""
    inDsml = false
    const calls = parseDsmlToolCalls(block)
    const hasCalls = calls.some((event) => event.type === "tool.call")
    if (hasCalls) dsmlCallsDetected = true
    return {
      events: hasCalls ? calls : block.length > 0 ? [{ type: "text.delta", text: block }] : [],
      hasCalls,
    }
  }

  const handleContent = (content: string): LLMEvent[] => {
    if (inDsml) {
      dsmlBuffer += content
      const closing = findDsmlClosing(dsmlBuffer)
      if (!closing) return []

      const block = dsmlBuffer.slice(0, closing.end)
      const rest = dsmlBuffer.slice(closing.end)
      dsmlBuffer = block
      const completed = completeDsml()
      return [...completed.events, ...(rest.length > 0 ? handleContent(rest) : [])]
    }

    const combined = `${textCarry}${content}`
    textCarry = ""
    const opening = findDsmlOpening(combined)
    if (opening !== undefined) {
      const events: LLMEvent[] = []
      if (opening.index > 0) events.push({ type: "text.delta", text: combined.slice(0, opening.index) })
      dsmlBuffer = combined.slice(opening.index)
      inDsml = true
      const closing = findDsmlClosing(dsmlBuffer)
      if (!closing) return events

      const block = dsmlBuffer.slice(0, closing.end)
      const rest = dsmlBuffer.slice(closing.end)
      dsmlBuffer = block
      const completed = completeDsml()
      return [...events, ...completed.events, ...(rest.length > 0 ? handleContent(rest) : [])]
    }

    const held = partialDsmlSuffix(combined)
    textCarry = held
    const text = held.length > 0 ? combined.slice(0, -held.length) : combined
    return text.length > 0 ? [{ type: "text.delta", text }] : []
  }

  const flushContent = (): { events: LLMEvent[]; hasCalls: boolean } => {
    const events: LLMEvent[] = []
    let hasCalls = false
    if (inDsml) {
      const completed = completeDsml()
      events.push(...completed.events)
      hasCalls = completed.hasCalls
    }
    if (textCarry.length > 0) {
      events.push({ type: "text.delta", text: textCarry })
      textCarry = ""
    }
    return { events, hasCalls }
  }

  const finish = (reason: string): LLMEvent[] => {
    const content = flushContent()
    const standardCalls = flushToolCalls()
    const hasCalls =
      dsmlCallsDetected ||
      content.hasCalls ||
      standardCalls.some((event) => event.type === "tool.call")
    return [
      ...content.events,
      ...standardCalls,
      { type: "finish", reason: hasCalls && reason === "stop" ? "tool_calls" : reason },
    ]
  }

  const push = (payload: string): DecoderResult => {
    if (payload.trim() === "[DONE]") {
      // 极少数实现不发 finish_reason 直接结束，这里补一个，保证消费方总能拿到收尾信号
      const events = finished ? [] : finish(lastFinishReason || "stop")
      finished = true
      return { events, done: true }
    }

    const chunk = parseChunk(payload)
    // 载荷不是合法 JSON：多数情况是心跳或注释，忽略即可
    if (chunk === undefined) return { events: [], done: false }

    // 流内的错误对象：例如生成中途触发内容审核
    if (chunk.error) {
      const code = chunk.error.code ?? chunk.error.type ?? ""
      const message = chunk.error.message ?? "模型服务在流式响应中返回错误"
      throw new LLMError("server", `${message}${code ? `（${code}）` : ""}`)
    }

    const events: LLMEvent[] = []

    if (chunk.usage) events.push({ type: "usage", usage: mapUsage(chunk.usage) })

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // 推理内容可能与正式回复交替到达，两种字段名都做兼容
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === "string" && reasoning.length > 0) {
        events.push({ type: "reasoning.delta", text: reasoning })
      }

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        events.push(...handleContent(delta.content))
      }

      for (const fragment of delta?.tool_calls ?? []) {
        const index = fragment.index ?? 0
        // callID 缺失时就地补一个本地 ID：部分兼容实现不返回 id，
        // 而「工具调用与结果必须能配对」是后续所有逻辑的前提
        const existing = pending.get(index) ?? { callID: newToolCallID(), name: "", args: "" }

        // id 与函数名通常只在首个分片出现，但按「拼接」处理对分片更宽容
        if (fragment.id) existing.callID = fragment.id
        if (fragment.function?.name) existing.name += fragment.function.name
        if (fragment.function?.arguments) {
          existing.args += fragment.function.arguments
          events.push({
            type: "tool.input.delta",
            callID: existing.callID || `pending_${index}`,
            text: fragment.function.arguments,
          })
        }

        pending.set(index, existing)
      }

      if (choice.finish_reason) {
        lastFinishReason = choice.finish_reason
        events.push(...finish(choice.finish_reason))
        finished = true
      }
    }

    // 只有 [DONE] 才代表流结束：finish_reason 之后还可能有用量帧要读
    return { events, done: false }
  }

  const finalize = (): LLMEvent[] => {
    if (finished) return []
    finished = true
    return finish("stop")
  }

  return { push, finalize }
}

const DSML_OPENINGS = ["<｜｜DSML｜｜", "<||DSML||"]
const DSML_CLOSINGS = ["</｜｜DSML｜｜ calls>", "</||DSML|| calls>", "</｜｜DSML｜｜>", "</||DSML||>"]

const findDsmlOpening = (text: string): { index: number; marker: string } | undefined => {
  let found: { index: number; marker: string } | undefined
  for (const marker of DSML_OPENINGS) {
    const index = text.indexOf(marker)
    if (index === -1) continue
    if (found === undefined || index < found.index) found = { index, marker }
  }
  return found
}

const findDsmlClosing = (text: string): { index: number; end: number } | undefined => {
  let found: { index: number; end: number } | undefined
  for (const marker of DSML_CLOSINGS) {
    const index = text.indexOf(marker)
    if (index === -1) continue
    const candidate = { index, end: index + marker.length }
    if (found === undefined || candidate.index < found.index) found = candidate
  }
  return found
}

const partialDsmlSuffix = (text: string): string => {
  let held = ""
  for (const marker of DSML_OPENINGS) {
    const maximum = Math.min(marker.length - 1, text.length)
    for (let length = maximum; length > held.length; length -= 1) {
      if (marker.startsWith(text.slice(-length))) {
        held = text.slice(-length)
        break
      }
    }
  }
  return held
}

/** 把部分兼容模型写在正文里的 DSML invoke 块转换成标准工具调用事件。 */
export const parseDsmlToolCalls = (text: string): LLMEvent[] => {
  if (!findDsmlOpening(text)) return []
  const normalized = text.replaceAll("｜", "|")
  const tag = "\\|\\|DSML\\|\\|"
  const invokePattern = new RegExp(
    `<${tag}\\s+invoke\\s+name="([^"]+)">([\\s\\S]*?)<\\/${tag}\\s+invoke>`,
    "gi",
  )
  const parameterPattern = new RegExp(
    `<${tag}\\s+parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)<\\/${tag}\\s+parameter>`,
    "gi",
  )
  const events: LLMEvent[] = []

  for (const invoke of normalized.matchAll(invokePattern)) {
    const name = decodeXml(invoke[1] ?? "")
    if (name.length === 0) continue
    const input: Record<string, unknown> = {}
    for (const parameter of (invoke[2] ?? "").matchAll(parameterPattern)) {
      const key = decodeXml(parameter[1] ?? "")
      if (key.length === 0) continue
      const raw = decodeXml(parameter[3] ?? "").trim()
      input[key] = parameter[2] === "true" ? raw : parseDsmlValue(raw)
    }
    events.push({
      type: "tool.call",
      callID: newToolCallID(),
      name,
      input,
    })
  }

  return events
}

const parseDsmlValue = (value: string): unknown => {
  if (value.length === 0) return ""
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

const decodeXml = (value: string): string =>
  value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|lt|gt|amp|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (entity.toLowerCase()) {
      case "&lt;":
        return "<"
      case "&gt;":
        return ">"
      case "&amp;":
        return "&"
      case "&quot;":
        return '"'
      case "&apos;":
        return "'"
      default:
        return entity
    }
  })

/** 把累积完成的工具调用转成事件，并尝试解析入参 JSON。 */
const toToolCallEvent = (call: PendingToolCall): LLMEvent => {
  const parsed = parseArguments(call.args)
  return {
    type: "tool.call",
    callID: call.callID || "",
    name: call.name,
    input: parsed.input,
    ...(parsed.parseError === undefined ? {} : { parseError: parsed.parseError }),
  }
}

const parseArguments = (raw: string): { input: unknown; parseError?: string } => {
  const text = raw.trim()
  // 无参工具时模型可能返回空字符串或干脆不发 arguments 分片
  if (text.length === 0) return { input: {} }
  try {
    return { input: JSON.parse(text) }
  } catch (error) {
    return { input: undefined, parseError: `工具入参不是合法 JSON：${describeError(error)}` }
  }
}

const parseChunk = (payload: string): ChatChunk | undefined => {
  try {
    const value: unknown = JSON.parse(payload)
    return typeof value === "object" && value !== null ? (value as ChatChunk) : undefined
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* 错误响应解析                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 把非 2xx 响应转成分类明确的 LLMError。
 *
 * 这里必须尽量把 provider 的原始错误文本带出来：兼容实现的错误格式五花八门，
 * 只给一个状态码会让用户完全无法排查（例如「model not found」这种关键信息
 * 常常只出现在 message 里）。
 */
export const toResponseError = async (response: Response): Promise<LLMError> => {
  const text = await response.text().catch(() => "")
  const parsed = safeParseJSON(text)

  const code = pickString(parsed, ["error", "code"]) ?? pickString(parsed, ["code"]) ?? ""
  const message =
    pickString(parsed, ["error", "message"]) ?? pickString(parsed, ["message"]) ?? (text.slice(0, 500) || "无响应体")

  const kind = classifyHTTPError(response.status, code, message)
  return new LLMError(kind, `模型服务返回 ${response.status}：${message}`, { status: response.status })
}

const safeParseJSON = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const pickString = (value: unknown, path: string[]): string | undefined => {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === "string" ? current : undefined
}
