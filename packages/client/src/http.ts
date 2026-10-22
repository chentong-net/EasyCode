import { ErrorBody, ProtocolError, type ErrorTag } from "@easycode/protocol"

/**
 * 客户端侧的 HTTP 请求工具。
 *
 * 只有一件事需要特别注意：**错误必须翻译成结构化的 ProtocolError**。
 * 直接抛出 `HTTP 500` 这类信息，上层就没法区分「会话不存在」和「服务端崩了」，
 * 只能去匹配错误消息文本，而文案是会变的。
 */

export interface TransportOptions {
  /** 服务基础地址，例如 http://127.0.0.1:53421 */
  baseUrl: string
  /** 访问令牌。桌面端由 preload 注入。 */
  token?: string
  /** fetch 实现。注入的目的是让测试可以替换掉真实网络。 */
  fetchImpl: typeof fetch
}

/** 拼接 URL，容忍 baseUrl 结尾多写或少写斜杠。 */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`

const authHeaders = (token: string | undefined): Record<string, string> =>
  token === undefined || token.length === 0 ? {} : { "x-easycode-token": token }

/**
 * 发起一次 JSON 请求。
 *
 * `signal` 贯穿所有调用，因为用户随时可能切换会话或关闭窗口：
 * 没有取消能力的话，这些请求会在后台继续跑完，白白占用连接和模型的算力。
 */
export const requestJSON = async <T>(
  transport: TransportOptions,
  method: "GET" | "POST" | "DELETE",
  path: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> => {
  const headers: Record<string, string> = { accept: "application/json", ...authHeaders(transport.token) }
  if (options.body !== undefined) headers["content-type"] = "application/json"

  const init: RequestInit = { method, headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  if (options.signal !== undefined) init.signal = options.signal

  const response = await transport.fetchImpl(joinUrl(transport.baseUrl, path), init)
  if (!response.ok) throw await toProtocolError(response)

  // 204 没有响应体，硬解析会抛错
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** 打开一个流式响应。SSE 需要自己读 body，所以不能走 requestJSON。 */
export const openStream = async (
  transport: TransportOptions,
  path: string,
  signal?: AbortSignal,
): Promise<Response> => {
  const init: RequestInit = {
    method: "GET",
    headers: { accept: "text/event-stream", ...authHeaders(transport.token) },
  }
  if (signal !== undefined) init.signal = signal

  const response = await transport.fetchImpl(joinUrl(transport.baseUrl, path), init)
  if (!response.ok) throw await toProtocolError(response)
  if (!response.body) throw new ProtocolError("internal", "服务端没有返回可读取的事件流", response.status)
  return response
}

/** 把非 2xx 响应翻译成 ProtocolError。 */
const toProtocolError = async (response: Response): Promise<ProtocolError> => {
  let tag: ErrorTag = response.status === 404 ? "not_found" : "internal"
  let message = `请求失败：HTTP ${response.status}`

  try {
    const parsed = ErrorBody.safeParse(await response.json())
    if (parsed.success) {
      tag = parsed.data.error.tag
      message = parsed.data.error.message
    }
  } catch {
    // 响应体不是合法 JSON（例如中间代理返回的 HTML 错误页），保留兜底信息
  }

  return new ProtocolError(tag, message, response.status)
}
