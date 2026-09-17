import {
  AgentListResponse,
  Endpoints,
  HealthResponse,
  MessageListResponse,
  PermissionListResponse,
  PromptResponse,
  ProtocolError,
  SessionListResponse,
  SessionResponse,
  withAfter,
  type AgentInfo,
  type CreateSessionRequest,
  type PromptRequest,
} from "@easycode/protocol"
import {
  isDurableEvent,
  type Event as StreamEvent,
  type Message,
  type PermissionReply,
  type PermissionRequest,
  type Session,
} from "@easycode/schema"
import { z, type ZodTypeAny } from "zod"

import { openStream, requestJSON, type TransportOptions } from "./http.js"
import { parseEventStream } from "./sse.js"

/**
 * 类型化客户端 SDK。
 *
 * 它是界面与 Core 之间唯一被允许的通信方式。渲染进程不 import core、
 * 不 import server，只 import 这个包——因此「UI 与 Core 分离」这条约束
 * 是被依赖方向强制的，而不是靠约定遵守。
 *
 * 本包保持浏览器安全：只用 fetch 与 Web 标准类型，不碰任何 node 内置模块。
 */

/** 重连退避的起点与上限。本地服务重启通常在一秒内完成，不需要更激进的策略。 */
const RECONNECT_MIN_DELAY_MS = 500
const RECONNECT_MAX_DELAY_MS = 5_000

export interface ClientHooks {
  /** 收到无法解析的事件帧时回调，用于日志排查。 */
  onInvalidEvent?: (raw: string) => void
  /** 事件流断开后准备重连。重连是自动的，这个回调只用于在界面上提示状态。 */
  onReconnecting?: (info: { attempt: number; delayMs: number; reason: string }) => void
}

export interface CreateClientOptions extends ClientHooks {
  /** 服务基础地址，由 preload 注入 */
  baseUrl: string
  /** 访问令牌，由 preload 注入 */
  token?: string
  /** 替换 fetch 实现，仅用于测试 */
  fetchImpl?: typeof fetch
}

/** 事件流的订阅选项。 */
export interface EventStreamOptions {
  /**
   * 从哪个序号之后开始补发。
   *
   * 界面重新挂载时传上一次收到的最大 seq，就能只拿到缺失的那一段，
   * 而不必重新拉取整个会话历史。
   */
  after?: number
  signal?: AbortSignal
}

export interface EasyCodeClient {
  /** 健康检查。桌面端主进程用它判断 sidecar 是否就绪。 */
  health(signal?: AbortSignal): Promise<{ ok: true; version: string; model: string }>
  /** 可用的 agent 列表 */
  agents(signal?: AbortSignal): Promise<AgentInfo[]>
  sessions: {
    list(signal?: AbortSignal): Promise<Session[]>
    create(input: CreateSessionRequest, signal?: AbortSignal): Promise<Session>
    get(sessionID: string, signal?: AbortSignal): Promise<Session>
    messages(sessionID: string, signal?: AbortSignal): Promise<Message[]>
    /** 提交输入。接口只负责接纳，执行进度通过事件流反馈。 */
    prompt(sessionID: string, input: PromptRequest, signal?: AbortSignal): Promise<PromptResponse>
    interrupt(sessionID: string, signal?: AbortSignal): Promise<void>
    permissions(sessionID: string, signal?: AbortSignal): Promise<PermissionRequest[]>
    replyPermission(
      sessionID: string,
      requestID: string,
      input: { reply: PermissionReply; feedback?: string },
      signal?: AbortSignal,
    ): Promise<void>
    /**
     * 订阅会话事件。惰性：直到被迭代才会发起连接。
     * 连接中断后自动重连并带上 after，界面不需要自己处理断线。
     */
    events(sessionID: string, options?: EventStreamOptions): AsyncIterable<StreamEvent>
  }
}

export const createClient = (options: CreateClientOptions): EasyCodeClient => {
  const transport: TransportOptions = {
    baseUrl: options.baseUrl,
    ...(options.token === undefined ? {} : { token: options.token }),
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  }
  const hooks: ClientHooks = {
    ...(options.onInvalidEvent === undefined ? {} : { onInvalidEvent: options.onInvalidEvent }),
    ...(options.onReconnecting === undefined ? {} : { onReconnecting: options.onReconnecting }),
  }

  return {
    health: (signal) => get(transport, Endpoints.health(), HealthResponse, signal),
    agents: (signal) => get(transport, Endpoints.agents(), AgentListResponse, signal),

    sessions: {
      list: (signal) => get(transport, Endpoints.sessions(), SessionListResponse, signal),

      create: (input, signal) => post(transport, Endpoints.sessions(), input, SessionResponse, signal),

      get: (sessionID, signal) => get(transport, Endpoints.session(sessionID), SessionResponse, signal),

      messages: (sessionID, signal) => get(transport, Endpoints.messages(sessionID), MessageListResponse, signal),

      prompt: (sessionID, input, signal) => post(transport, Endpoints.prompt(sessionID), input, PromptResponse, signal),

      interrupt: async (sessionID, signal) => {
        await post(transport, Endpoints.interrupt(sessionID), undefined, OkResponseSchema, signal)
      },

      permissions: (sessionID, signal) =>
        get(transport, Endpoints.permissions(sessionID), PermissionListResponse, signal),

      replyPermission: async (sessionID, requestID, input, signal) => {
        await post(transport, Endpoints.permissionReply(sessionID, requestID), input, OkResponseSchema, signal)
      },

      events: (sessionID, streamOptions = {}) => streamSessionEvents(transport, hooks, sessionID, streamOptions),
    },
  }
}

/** 中断与审批回应共用的响应体。它的结构简单到不值得单独放进 protocol。 */
const OkResponseSchema = z.object({ ok: z.literal(true) })

/* -------------------------------------------------------------------------- */
/* 请求辅助                                                                    */
/* -------------------------------------------------------------------------- */

const get = async <T extends ZodTypeAny>(
  transport: TransportOptions,
  path: string,
  schema: T,
  signal?: AbortSignal,
): Promise<z.infer<T>> => {
  const raw = await requestJSON<unknown>(transport, "GET", path, signal === undefined ? {} : { signal })
  return parseResponse(schema, raw, path)
}

const post = async <T extends ZodTypeAny>(
  transport: TransportOptions,
  path: string,
  body: unknown,
  schema: T,
  signal?: AbortSignal,
): Promise<z.infer<T>> => {
  const raw = await requestJSON<unknown>(transport, "POST", path, {
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
  })
  return parseResponse(schema, raw, path)
}

/**
 * 校验响应体。
 *
 * 服务端与客户端是两个独立构建的产物，版本错配时最典型的症状是
 * 「某个字段悄悄变成 undefined」，然后在很远的地方炸掉。
 * 在这里校验能把问题钉死在接口边界上，错误信息也直接指向具体的字段。
 */
const parseResponse = <T extends ZodTypeAny>(schema: T, raw: unknown, path: string): z.infer<T> => {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return parsed.data

  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(根)"}: ${issue.message}`)
    .join("；")
  throw new ProtocolError("internal", `响应结构不符合预期（${path}）：${detail}`)
}

/* -------------------------------------------------------------------------- */
/* 事件流                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 订阅会话事件，并在连接中断后自动重连。
 *
 * 重连时带上 `after=已收到的最大序号`，服务端只补发缺失的那一段。
 * 这让「sidecar 重启」「网络瞬断」这类情况对界面完全透明：
 * 用户看到的是内容继续刷新，而不是需要手动刷新页面。
 *
 * 这个函数是 async generator，因此连接是在第一次迭代时才建立的——
 * 界面只要拿到 iterable 而不消费它，就不会产生任何网络开销。
 */
async function* streamSessionEvents(
  transport: TransportOptions,
  hooks: ClientHooks,
  sessionID: string,
  options: EventStreamOptions,
): AsyncGenerator<StreamEvent> {
  const signal = options.signal
  let after = options.after
  let attempt = 0

  while (!signal?.aborted) {
    try {
      const response = await openStream(transport, withAfter(Endpoints.events(sessionID), after), signal)
      // 连上了就重置退避：下一轮断开理应重新从最小间隔开始
      attempt = 0

      const parseOptions =
        hooks.onInvalidEvent === undefined ? {} : { onInvalid: hooks.onInvalidEvent }

      for await (const event of parseEventStream(response.body as ReadableStream<Uint8Array>, parseOptions)) {
        if (isDurableEvent(event)) after = event.seq
        yield event
      }

      // 流被服务端正常关闭（例如进程重启）：按断线处理，走下面的重连分支
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return
      hooks.onReconnecting?.({
        attempt: attempt + 1,
        delayMs: reconnectDelay(attempt + 1),
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    if (signal?.aborted) return

    attempt += 1
    const delayMs = reconnectDelay(attempt)
    // 第一次因为异常已经报过通知了，这里只补上「正常关闭」的情况
    if (attempt === 1) {
      hooks.onReconnecting?.({ attempt, delayMs, reason: "事件流已断开" })
    }

    try {
      await delay(delayMs, signal)
    } catch {
      // 等待期间被取消（例如用户切换了会话），直接结束即可
      return
    }
  }
}

/** 指数退避，封顶在 RECONNECT_MAX_DELAY_MS。 */
const reconnectDelay = (attempt: number): number =>
  Math.min(RECONNECT_MIN_DELAY_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_DELAY_MS)

/** 可取消的等待。取消时抛错，由调用方决定如何处理。 */
const delay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("已取消"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error("已取消"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError"
