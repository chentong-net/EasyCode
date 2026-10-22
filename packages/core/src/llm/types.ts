import type { Content, ToolDefinition, Usage } from "@easycode/schema"

/**
 * LLM 协议层的类型定义。
 *
 * 这一层的职责边界：把「会话投影出的消息」翻译成某家 provider 的报文，
 * 再把 provider 返回的字节流翻译成与 provider 无关的归一化事件。
 * 它不关心会话、工具执行、权限——那些属于 runner。
 */

/** 模型要求执行的一次工具调用。 */
export interface LLMToolCall {
  callID: string
  name: string
  /** 已解析的入参。解析失败时由 parseError 说明原因，此时 input 为 undefined */
  input: unknown
}

/** 发给模型的一条消息。 */
export type LLMMessage =
  | { role: "system"; text: string }
  | { role: "user"; content: Content[] }
  | { role: "assistant"; text: string; toolCalls: LLMToolCall[] }
  | { role: "tool"; callID: string; content: Content[] }

/**
 * 一次 provider turn 的完整请求。
 *
 * 注意 `system` 是数组而不是字符串：第一段是 agent 自身的系统提示词，
 * 第二段是冻结的 baseline 系统上下文。分开保留是为了让日志能看清
 * 「请求前缀里哪一段来自哪里」，排查缓存问题时非常有用。
 */
export interface LLMRequest {
  model: string
  system: string[]
  messages: LLMMessage[]
  tools: ToolDefinition[]
  /** 达到 agent 步数上限时设为 none，强制模型直接给出最终答复 */
  toolChoice?: "auto" | "none"
  /** provider 允许生成的最大输出 token 数 */
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** 会话 ID，用于把同一会话的请求路由到同一后端，提升 prompt 缓存命中率 */
  sessionID?: string
}

/**
 * 归一化之后的流式事件。
 *
 * 刻意不带 part 下标：part 的切分是投影层的事（比如「工具调用之后又出现文本」
 * 应该新开一个 part），让协议层去猜 part 边界会把两层的职责搅在一起。
 */
export type LLMEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.input.delta"; callID: string; text: string }
  | {
      type: "tool.call"
      callID: string
      name: string
      input: unknown
      /** 入参不是合法 JSON 时说明原因，runner 会据此直接把该次调用判为失败 */
      parseError?: string
    }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: string }

/** LLM 客户端接口。只有这一个方法，一次调用对应一次 provider turn。 */
export interface LLMClient {
  stream(request: LLMRequest): AsyncIterable<LLMEvent>
}

/** 客户端运行所需的连接配置，全部来自 .env。 */
export interface LLMClientConfig {
  baseUrl: string
  apiKey: string
  /** 附加请求头，用于兼容需要特殊头的网关 */
  headers?: Record<string, string>
}
