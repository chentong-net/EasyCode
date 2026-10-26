import { ToolFailure } from "../../../errors.js"
import type { Logger } from "../../../log.js"
import type { WebProviderID } from "./types.js"

interface RequestOptions {
  provider: WebProviderID
  url: string
  apiKey: string
  body: unknown
  signal: AbortSignal
  timeoutMs: number
  maxResponseBytes: number
  userAgent: string
  logger: Logger
}

/** 发送 JSON POST，并把网络、超时和 HTTP 错误统一成 ToolFailure。 */
export const postJSON = async (options: RequestOptions): Promise<unknown> => {
  if (options.signal.aborted) {
    throw new ToolFailure("联网请求已被中断", { kind: "aborted" })
  }

  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => controller.abort(options.signal.reason)
  options.signal.addEventListener("abort", forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  timer.unref()

  try {
    let response: Response
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "user-agent": options.userAgent,
        },
        body: JSON.stringify(options.body),
        signal: controller.signal,
      })
    } catch (error) {
      if (options.signal.aborted) {
        throw new ToolFailure("联网请求已被中断", { kind: "aborted" })
      }
      if (timedOut) {
        throw new ToolFailure(`联网请求超时（${options.timeoutMs}ms）`, {
          kind: "timeout",
          retryable: true,
        })
      }
      throw new ToolFailure(`无法连接 ${options.provider} 服务：${errorMessage(error)}`, {
        kind: "transient",
        retryable: true,
      })
    }

    let text: string
    try {
      text = await readBoundedText(response, options.maxResponseBytes)
    } catch (error) {
      if (timedOut) {
        throw new ToolFailure(`联网请求超时（${options.timeoutMs}ms）`, {
          kind: "timeout",
          retryable: true,
        })
      }
      if (error instanceof ToolFailure) throw error
      throw new ToolFailure(`读取 ${options.provider} 响应失败：${errorMessage(error)}`, {
        kind: "transient",
        retryable: true,
      })
    }

    if (!response.ok) {
      throw httpFailure(options.provider, response.status, text)
    }
    if (text.trim().length === 0) {
      throw new ToolFailure(`${options.provider} 返回了空响应`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new ToolFailure(`${options.provider} 返回的不是合法 JSON`)
    }
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener("abort", forwardAbort)
  }
}

const readBoundedText = async (response: Response, maximum: number): Promise<string> => {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximum) {
    throw new ToolFailure(`厂商响应超过 ${maximum} 字节上限`, { kind: "invalid_input" })
  }

  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) {
        throw new ToolFailure(`厂商响应超过 ${maximum} 字节上限`, { kind: "invalid_input" })
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
}

const httpFailure = (provider: string, status: number, text: string): ToolFailure => {
  const detail = responseMessage(text)
  const suffix = detail ? `：${detail}` : ""
  if (status === 429) {
    return new ToolFailure(`${provider} 请求被限流（HTTP 429）${suffix}`, {
      kind: "transient",
      retryable: true,
    })
  }
  if (status === 408 || status === 504) {
    return new ToolFailure(`${provider} 请求超时（HTTP ${status}）${suffix}`, {
      kind: "timeout",
      retryable: true,
    })
  }
  if (status >= 500) {
    return new ToolFailure(`${provider} 服务暂时不可用（HTTP ${status}）${suffix}`, {
      kind: "transient",
      retryable: true,
    })
  }
  if (status === 404) {
    return new ToolFailure(`${provider} 没有返回可用内容（HTTP 404）${suffix}`, { kind: "not_found" })
  }
  if (status === 401 || status === 403) {
    return new ToolFailure(`${provider} 鉴权失败（HTTP ${status}）${suffix}`)
  }
  if (status >= 400) {
    return new ToolFailure(`${provider} 拒绝了请求（HTTP ${status}）${suffix}`, { kind: "invalid_input" })
  }
  return new ToolFailure(`${provider} 请求失败（HTTP ${status}）${suffix}`)
}

const responseMessage = (text: string): string | undefined => {
  try {
    const payload = JSON.parse(text) as unknown
    return findMessage(payload)
  } catch {
    const value = text.replace(/\s+/g, " ").trim()
    return value ? value.slice(0, 300) : undefined
  }
}

const findMessage = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim() || undefined
  if (!isRecord(value)) return undefined
  for (const key of ["message", "error", "detail", "msg"]) {
    const nested = findMessage(value[key])
    if (nested) return nested
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
