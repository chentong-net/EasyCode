import { createServer, type Server } from "node:http"

import type { Core } from "@easycode/core"
import { createLogger, type Logger } from "@easycode/core"

import { createRequestHandler, describeEndpoints } from "./routes.js"

/**
 * 本地 HTTP 服务。
 *
 * 它是 Core 与界面之间唯一的通道，因此承担三件事：
 * 1. 只监听回环地址，绝不接受外部连接
 * 2. 用启动时随机生成的 token 做鉴权，防止本机其它程序随意驱动 agent
 * 3. 端口默认由系统分配（port: 0），避免固定端口在用户机器上被占用而启动失败
 *
 * 这里不实现 TLS：流量不出本机，加证书只会让桌面端的启动流程变复杂。
 */

export interface ListenOptions {
  core: Core
  /** 监听端口。0 表示由系统分配一个空闲端口，这是桌面端的默认策略。 */
  port?: number
  /** 监听地址。只监听回环地址，不提供对外服务的选项。 */
  host?: string
  /**
   * 访问令牌。桌面端会生成一个随机值并注入渲染进程；
   * 传空字符串表示不校验，仅用于本地 CLI 调试。
   */
  token?: string
  logger?: Logger
}

export interface RunningServer {
  /** 完整的基础地址，例如 http://127.0.0.1:53421 */
  url: string
  port: number
  token?: string
  /** 实际监听的地址 */
  host: string
  close(): Promise<void>
}

export const listen = async (options: ListenOptions): Promise<RunningServer> => {
  const logger = options.logger ?? createLogger("server")
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0

  const handler = createRequestHandler({
    core: options.core,
    ...(options.token === undefined ? {} : { token: options.token }),
    logger,
  })

  const server = createServer(handler)

  // 事件流的连接可能长时间空闲，默认的请求超时会把它拦腰截断
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  await listenOn(server, port, host)

  const address = server.address()
  if (address === null || typeof address === "string") {
    await close(server)
    throw new Error("服务启动失败：无法确定监听端口")
  }

  const url = `http://${host}:${address.port}`
  logger.info("HTTP 服务已启动", { url, authEnabled: options.token !== undefined && options.token.length > 0 })
  for (const line of describeEndpoints()) logger.debug("端点", { route: line })

  return {
    url,
    port: address.port,
    host,
    ...(options.token === undefined ? {} : { token: options.token }),
    close: () => close(server, logger),
  }
}

/** 把 listen 的错误事件转成 Promise 的 reject，避免启动失败被静默吞掉。 */
const listenOn = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })

/**
 * 关闭服务。
 *
 * 先停止接受新连接，再销毁所有存活连接：SSE 是长连接，
 * 不主动销毁的话 `close()` 会一直等到客户端自己断开，
 * 桌面端就会卡在「正在退出」上。
 */
const close = async (server: Server, logger?: Logger): Promise<void> => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
  logger?.info("HTTP 服务已关闭")
}

export { createRequestHandler, describeEndpoints } from "./routes.js"
export * from "./http.js"
export * from "./sse.js"
