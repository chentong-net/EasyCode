import type { IncomingMessage, ServerResponse } from "node:http"

import { ProtocolError, statusForTag, type ErrorTag } from "@easycode/protocol"

/**
 * HTTP 层的公共工具：统一的响应头、错误返回、请求体读取。
 *
 * 这些事必须在所有路由上完全一致，否则会出现「大部分接口能跨域、某个接口不带
 * CORS 头」这种极难排查的问题——浏览器只会说「请求失败」，不给任何细节。
 */

/** 单次请求体的上限。本地接口的请求体都很小，超过这个量说明不是正常调用。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 所有响应共有的头。
 *
 * 使用回环地址并启用 token 时，CORS 放开到 `*` 仍依赖 token 保护接口。
 * 当调用方显式覆盖 host 或使用 `--no-token` 时，不能把这条结论当作安全保证。
 */
export const commonHeaders = (): Record<string, string> => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-easycode-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
})

/** 发送 JSON 响应。 */
export const sendJSON = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...commonHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 发送错误响应。
 *
 * 客户端据此得到结构化的错误标签，可以做可靠的分支判断，
 * 而不是去匹配错误消息里的关键词。
 */
export const sendError = (res: ServerResponse, tag: ErrorTag, message: string): void => {
  sendJSON(res, statusForTag(tag), { error: { tag, message } })
}

/** 应答 CORS 预检请求。浏览器跨域请求携带自定义头时通常会先发 OPTIONS。 */
export const sendPreflight = (res: ServerResponse): void => {
  res.writeHead(204, commonHeaders())
  res.end()
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 边读边累计长度，超过上限立刻中断连接：否则一个畸形的请求
 * 就能把整个 sidecar 进程的内存吃光。
 */
export const readJSON = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new ProtocolError("bad_request", `请求体超过上限（${MAX_BODY_BYTES} 字节）`)
    }
    chunks.push(buffer)
  }

  if (size === 0) return undefined

  const text = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProtocolError("bad_request", "请求体不是合法的 JSON")
  }
}
