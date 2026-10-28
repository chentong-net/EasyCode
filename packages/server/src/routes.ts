import type { IncomingMessage, ServerResponse } from "node:http"

import { calculateCompactionBudget, type Core, type Logger } from "@easycode/core"
import {
  API_VERSION,
  CreateWorkspaceRequest,
  CreateSessionRequest,
  Endpoints,
  PinWorkspaceRequest,
  PinSessionRequest,
  PermissionReplyRequest,
  PromptRequest,
  ProtocolError,
  RenameWorkspaceRequest,
  RenameSessionRequest,
  AFTER_QUERY_PARAM,
  AUTH_HEADER,
  type HealthResponse,
} from "@easycode/protocol"
import { z, type ZodTypeAny } from "zod"

import { readJSON, sendError, sendJSON, sendPreflight } from "./http.js"
import { streamEvents } from "./sse.js"

/**
 * 路由层：把 HTTP 请求翻译成 Core 的调用，再把结果翻译回 JSON。
 *
 * 这里刻意不引入任何 HTTP 框架。全部路由只有十来个，用原生 http 模块
 * 手写分发反而更清楚：没有隐式的中间件顺序，没有「为什么这个请求没进这个
 * 处理器」这类问题，也不给 sidecar 增加额外的启动开销。
 *
 * 三条约定：
 * - 路径参数一律 decodeURIComponent 之后再使用
 * - 任何非 2xx 都走 sendError，保证客户端拿到的是结构化错误
 * - 业务异常（缺参、找不到会话）抛 ProtocolError，由外层统一转成响应
 */

export interface RequestHandlerOptions {
  core: Core
  /** 鉴权 token。为空表示不校验（仅供本地 CLI 调试使用）。 */
  token?: string
  logger: Logger
}

/** 把请求体按 schema 解析，失败时抛出带细节的 bad_request。 */
const parseBody = <T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> => {
  const result = schema.safeParse(body)
  if (result.success) return result.data

  const detail = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(根)"}: ${issue.message}`)
    .join("；")
  throw new ProtocolError("bad_request", `请求参数不合法：${detail}`)
}

/** 取出会话，不存在时抛 not_found。 */
const requireSession = async (core: Core, sessionID: string) => {
  const session = await core.sessions.get(sessionID)
  if (!session) throw new ProtocolError("not_found", `会话不存在：${sessionID}`)
  return session
}

export const createRequestHandler =
  (options: RequestHandlerOptions) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(options, req, res).catch((error) => {
      handleFailure(options.logger, req, res, error)
    })
  }

const handleRequest = async (
  options: RequestHandlerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const { core, logger } = options
  const method = req.method ?? "GET"

  // 预检请求不带业务语义，也不带自定义头，必须在鉴权之前应答
  if (method === "OPTIONS") {
    sendPreflight(res)
    return
  }

  if (!isAuthorized(options.token, req)) {
    logger.warn("拒绝未授权的请求", { method, url: req.url })
    sendError(res, "bad_request", "缺少或错误的访问令牌")
    return
  }

  const url = new URL(req.url ?? "/", "http://localhost")
  const segments = url.pathname.split("/").filter((part) => part.length > 0)
  const [prefix, resource, ...rest] = segments

  if (prefix !== "api") {
    throw new ProtocolError("not_found", `未知路径：${url.pathname}`)
  }

  if (resource === "health" && method === "GET" && rest.length === 0) {
    const budget = calculateCompactionBudget(core.config)
    sendJSON(res, 200, {
      ok: true,
      version: API_VERSION,
      model: core.config.model,
      contextWindow: core.config.contextWindow,
      maxOutputTokens: budget.outputTokens,
    } satisfies HealthResponse)
    return
  }

  if (resource === "agents" && method === "GET" && rest.length === 0) {
    sendJSON(
      res,
      200,
      core.agents.all().map((agent) => ({ id: agent.id, description: agent.description })),
    )
    return
  }

  if (resource === "workspaces") {
    if (rest.length === 0) {
      if (method === "GET") {
        sendJSON(res, 200, await core.workspaces.list())
        return
      }
      if (method === "POST") {
        const body = parseBody(CreateWorkspaceRequest, await readJSON(req))
        sendJSON(res, 201, await core.workspaces.add(body.directory))
        return
      }
      throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
    }

    if (rest.length === 1) {
      if (method !== "PATCH") throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
      const workspaceID = decodeURIComponent(rest[0] as string)
      const body = parseBody(RenameWorkspaceRequest, await readJSON(req))
      sendJSON(res, 200, await core.workspaces.rename(workspaceID, body.name))
      return
    }

    const action = rest[1]
    if (rest.length === 2 && action === "pin") {
      if (method !== "POST") throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
      const workspaceID = decodeURIComponent(rest[0] as string)
      const body = parseBody(PinWorkspaceRequest, await readJSON(req))
      sendJSON(res, 200, await core.workspaces.pin(workspaceID, body.pinned))
      return
    }
  }

  if (resource !== "sessions") {
    throw new ProtocolError("not_found", `未知路径：${url.pathname}`)
  }

  // ---- /api/sessions ----

  if (rest.length === 0) {
    if (method === "GET") {
      sendJSON(res, 200, await core.sessions.list())
      return
    }
    if (method === "POST") {
      const body = parseBody(CreateSessionRequest, await readJSON(req))
      const session = await core.sessions.create(
        body.title === undefined ? { directory: body.directory } : { directory: body.directory, title: body.title },
      )
      sendJSON(res, 201, session)
      return
    }
    throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
  }

  // ---- /api/sessions/:id/... ----

  const sessionID = decodeURIComponent(rest[0] as string)
  const action = rest[1]

  if (action === undefined) {
    await requireSession(core, sessionID)
    if (method === "GET") {
      sendJSON(res, 200, await core.sessions.get(sessionID))
      return
    }
    if (method === "DELETE") {
      await core.sessions.delete(sessionID)
      sendJSON(res, 200, { ok: true })
      return
    }
    if (method === "PATCH") {
      const body = parseBody(RenameSessionRequest, await readJSON(req))
      sendJSON(res, 200, await core.sessions.rename(sessionID, body.title))
      return
    }
    throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
  }

  if (action === "pin") {
    if (method !== "POST") throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
    await requireSession(core, sessionID)
    const body = parseBody(PinSessionRequest, await readJSON(req))
    sendJSON(res, 200, await core.sessions.pin(sessionID, body.pinned))
    return
  }

  switch (action) {
    case "messages": {
      await requireSession(core, sessionID)
      sendJSON(res, 200, await core.sessions.messages(sessionID))
      return
    }

    case "prompt": {
      await requireSession(core, sessionID)
      const body = parseBody(PromptRequest, await readJSON(req))
      const result = await core.sessions.prompt(
        sessionID,
        body.delivery === undefined ? { text: body.text } : { text: body.text, delivery: body.delivery },
      )
      sendJSON(res, 202, result)
      return
    }

    case "interrupt": {
      await requireSession(core, sessionID)
      await core.sessions.interrupt(sessionID)
      sendJSON(res, 200, { ok: true })
      return
    }

    case "events": {
      // 走 SSE 之后响应就交给 streamEvents 接管，不再经过 JSON 响应路径
      const after = readAfter(url)
      await streamEvents({ core, sessionID, after, res, logger })
      return
    }

    case "permissions": {
      // GET /api/sessions/:id/permissions —— 待审批列表
      if (rest.length === 2) {
        if (method !== "GET") throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
        const handle = await core.sessions.handle(sessionID)
        sendJSON(res, 200, core.permissions.pending(handle))
        return
      }

      // POST /api/sessions/:id/permissions/:requestID/reply
      const requestID = rest[2] === undefined ? undefined : decodeURIComponent(rest[2])
      if (rest.length === 4 && rest[3] === "reply" && requestID !== undefined) {
        if (method !== "POST") throw new ProtocolError("not_found", `不支持的方法：${method} ${url.pathname}`)
        const body = parseBody(PermissionReplyRequest, await readJSON(req))
        const handle = await core.sessions.handle(sessionID)
        await core.permissions.reply({
          handle,
          requestID,
          reply: body.reply,
          ...(body.feedback === undefined ? {} : { feedback: body.feedback }),
        })
        sendJSON(res, 200, { ok: true })
        return
      }

      throw new ProtocolError("not_found", `未知路径：${url.pathname}`)
    }

    default:
      throw new ProtocolError("not_found", `未知路径：${url.pathname}`)
  }
}

/** 校验访问令牌。使用定时比较意义不大：token 只在本机回环地址上传递。 */
const isAuthorized = (expected: string | undefined, req: IncomingMessage): boolean => {
  if (expected === undefined || expected.length === 0) return true
  const provided = req.headers[AUTH_HEADER]
  const value = Array.isArray(provided) ? provided[0] : provided
  return value === expected
}

/** 解析事件流的 after 查询参数。非法值按 0 处理，即从头补发。 */
const readAfter = (url: URL): number | undefined => {
  const raw = url.searchParams.get(AFTER_QUERY_PARAM)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** 统一把异常翻译成响应。 */
const handleFailure = (logger: Logger, req: IncomingMessage, res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    // 已经进入 SSE 或其它流式响应，此时只能断开连接
    logger.warn("响应已开始发送，无法返回错误", { url: req.url, error })
    res.end()
    return
  }

  if (error instanceof ProtocolError) {
    logger.debug("请求被拒绝", { method: req.method, url: req.url, tag: error.tag, message: error.message })
    sendError(res, error.tag, error.message)
    return
  }

  const message = error instanceof Error ? error.message : String(error)
  logger.error("处理请求时发生未预期的错误", { method: req.method, url: req.url, error })
  sendError(res, "internal", message)
}

/** 供调试使用：把全部端点列成文本，方便在日志里提示可用接口。 */
export const describeEndpoints = (): string[] => [
  `GET  ${Endpoints.health()}`,
  `GET  ${Endpoints.agents()}`,
  `GET  ${Endpoints.workspaces()}`,
  `POST ${Endpoints.workspaces()}`,
  `PATCH ${Endpoints.workspace(":id")}`,
  `POST ${Endpoints.pinWorkspace(":id")}`,
  `GET  ${Endpoints.sessions()}`,
  `POST ${Endpoints.sessions()}`,
  `GET  ${Endpoints.session(":id")}`,
  `PATCH ${Endpoints.renameSession(":id")}`,
  `DELETE ${Endpoints.session(":id")}`,
  `POST ${Endpoints.pinSession(":id")}`,
  `GET  ${Endpoints.messages(":id")}`,
  `POST ${Endpoints.prompt(":id")}`,
  `POST ${Endpoints.interrupt(":id")}`,
  `GET  ${Endpoints.events(":id")}`,
  `GET  ${Endpoints.permissions(":id")}`,
  `POST ${Endpoints.permissionReply(":id", ":requestID")}`,
]
