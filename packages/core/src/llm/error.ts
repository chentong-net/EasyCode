/**
 * LLM 调用错误。
 *
 * 把所有 provider 的失败归一成有限的几类，目的是让上层能做出正确反应：
 * 上下文超限要触发 compaction（压缩）重试，认证失败要直接提示用户，网络问题可以重试，
 * 中断则必须原样向上传播（不能被当成普通失败吞掉）。
 */

export type LLMErrorKind =
  /** 认证失败：key 无效、无权限 */
  | "auth"
  /** 触发限流或配额耗尽 */
  | "rate_limit"
  /** 输入超出模型上下文窗口，需要执行 compaction 后重试 */
  | "context_overflow"
  /** 请求本身不合法：字段不被支持、参数越界 */
  | "invalid_request"
  /** 服务端 5xx */
  | "server"
  /** 网络不可达、连接中断 */
  | "network"
  /** 用户主动取消 */
  | "aborted"
  /** 响应格式不符合预期，例如流里出现非法 JSON */
  | "protocol"
  | "unknown"

export interface LLMErrorOptions {
  status?: number
  cause?: unknown
}

export class LLMError extends Error {
  readonly kind: LLMErrorKind
  /** HTTP 状态码，网络错误时为 undefined */
  readonly status?: number

  constructor(kind: LLMErrorKind, message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "LLMError"
    this.kind = kind
    this.status = options.status
  }

  /** 是否属于「稍后重试可能成功」的类别。中断与参数错误不属于此类。 */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "network" || this.kind === "server"
  }
}

/** 从任意错误中取出可读的消息文本，用于写入会话事件。 */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 判断是否为上下文超限错误。 */
export const isContextOverflowError = (error: unknown): boolean =>
  error instanceof LLMError && error.kind === "context_overflow"

/** 判断是否为用户中断。 */
export const isAbortError = (error: unknown): boolean =>
  (error instanceof LLMError && error.kind === "aborted") ||
  (error instanceof Error && error.name === "AbortError")

/**
 * 根据 HTTP 状态码与响应体判断错误类别。
 *
 * 上下文超限的判定不能只看状态码：OpenAI 返回 400，部分兼容实现返回 413，
 * 还有的把它塞在 message 文本里，所以这里同时检查状态码、错误码和文本特征。
 */
export const classifyHTTPError = (status: number, code: string, message: string): LLMErrorKind => {
  const text = `${code} ${message}`.toLowerCase()

  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status >= 500) return "server"

  const overflowSignals = [
    "context_length_exceeded",
    "context length",
    "maximum context",
    "context window",
    "too many tokens",
    "reduce the length",
    "prompt is too long",
  ]
  if (status === 413 || overflowSignals.some((signal) => text.includes(signal))) return "context_overflow"

  if (status === 400 || status === 404 || status === 422) return "invalid_request"
  return "unknown"
}
