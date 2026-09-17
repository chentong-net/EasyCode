import { createLogger, type Logger } from "../log.js"
import { describeError, isAbortError, LLMError } from "./error.js"
import { buildRequestBody, createStreamDecoder, toResponseError } from "./protocol.js"
import { readServerSentEvents } from "./stream.js"
import type { LLMClient, LLMClientConfig, LLMEvent, LLMRequest } from "./types.js"

/**
 * OpenAI 兼容协议的流式客户端。
 *
 * 它只负责「一次 provider turn」：发一个请求，把响应字节流翻译成归一化事件。
 * 不重试、不压缩、不碰会话状态——那些是 runner 的职责。
 * 保持这一层的单薄，是让上层能自由编排（压缩重试、步数控制、中断）的前提。
 */
export const createLLMClient = (config: LLMClientConfig, logger: Logger = createLogger("llm")): LLMClient => ({
  stream: (request) => streamTurn(config, request, logger),
})

async function* streamTurn(
  config: LLMClientConfig,
  request: LLMRequest,
  logger: Logger,
): AsyncGenerator<LLMEvent> {
  const url = joinUrl(config.baseUrl, "chat/completions")
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  }
  // 部分网关按会话做亲和路由，带上会话标记能显著提升 prompt 缓存命中率
  if (request.sessionID) headers["x-session-id"] = request.sessionID

  const body = buildRequestBody(request)
  logger.debug("发起 provider 请求", {
    url,
    model: request.model,
    messageCount: request.messages.length,
    toolCount: request.tools.length,
    systemChars: request.system.join("").length,
  })

  const startedAt = Date.now()
  const response = await sendRequest(url, headers, body, request.signal, logger)

  const decoder = createStreamDecoder()
  let chunkCount = 0

  try {
    for await (const payload of readServerSentEvents(response.body as ReadableStream<Uint8Array>)) {
      const result = decoder.push(payload)
      chunkCount += 1
      for (const event of result.events) yield event
      if (result.done) break
    }

    // 连接在没有 [DONE] 的情况下被关闭时，把残留的工具调用补吐出来，
    // 否则模型已经发出的调用会被静默丢弃
    for (const event of decoder.finalize()) yield event
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) {
      logger.info("provider 请求被取消", { afterMs: Date.now() - startedAt, chunkCount })
      throw new LLMError("aborted", "模型请求已被取消", { cause: error })
    }
    throw error
  } finally {
    logger.debug("provider 请求结束", { durationMs: Date.now() - startedAt, chunkCount })
  }
}

/** 发送请求并处理传输层与状态码层面的错误。 */
const sendRequest = async (
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw new LLMError("aborted", "模型请求已被取消", { cause: error })
    }
    logger.error("无法连接模型服务", { url, error: describeError(error) })
    throw new LLMError("network", `无法连接模型服务：${describeError(error)}`, { cause: error })
  }

  if (!response.ok) {
    const failure = await toResponseError(response)
    logger.error("模型服务返回错误", { status: failure.status, kind: failure.kind, message: failure.message })
    throw failure
  }

  if (!response.body) {
    throw new LLMError("protocol", "响应没有可读取的流式内容，无法解析模型输出", { status: response.status })
  }

  return response
}

/** 拼接 URL，容忍 baseUrl 结尾多写或少写斜杠。 */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
