import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

import type { Delivery, DurableEvent, Message, Session } from "@easycode/schema"
import { zeroUsage } from "@easycode/schema"

import type { AgentRegistry } from "../agent.js"
import type { CoreConfig } from "../config.js"
import type { EventHub } from "../events.js"
import { newInputID, newSessionID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { applyEvent, createProjectedState, projectEvents, type ProjectedState } from "./projector.js"
import type { NewDurableEvent, PersistedContext, SessionStore } from "./store.js"

/**
 * 一个回合的运行控制。
 *
 * runner 通过它登记「是否正在运行」「取消控制器」「当前任务」，管理器则用它
 * 实现中断。这些字段必须由 runner 在**任何 await 之前**同步设置好，
 * 否则紧接着到来的中断请求会看到 running=false 而被当成空操作丢弃。
 */
export interface RunControl {
  running: boolean
  controller?: AbortController
  task?: Promise<void>
}

/** 一个已加载到内存的会话。 */
export interface SessionHandle {
  readonly id: string
  /** 内存投影状态。只读使用，写操作一律通过 append 走事件日志。 */
  readonly state: ProjectedState
  readonly run: RunControl

  /** 追加一条持久化事件：分配序号 → 落盘 → 更新投影 → 广播 → 必要时同步会话缓存 */
  append(event: NewDurableEvent): Promise<DurableEvent>
  readContext(): Promise<PersistedContext | undefined>
  saveContext(context: PersistedContext): Promise<void>
}

export interface SessionManagerDeps {
  config: CoreConfig
  store: SessionStore
  hub: EventHub
  agents: AgentRegistry
  logger?: Logger
}

/** 运行时的唤醒回调。由 runner 注册。 */
export type WakeHandler = (sessionID: string) => void

export interface SessionManager {
  /** 全部会话，按更新时间倒序。侧边栏使用。 */
  list(): Promise<Session[]>
  /** 在工作目录下创建会话 */
  create(input: { directory: string; title?: string }): Promise<Session>
  get(sessionID: string): Promise<Session | undefined>
  /** 投影后的消息列表 */
  messages(sessionID: string): Promise<Message[]>
  /** 接纳一条用户输入并唤醒执行。这是 UI 唯一的写入口。 */
  prompt(sessionID: string, input: { text: string; delivery?: Delivery }): Promise<{ inputID: string }>
  /** 中断当前回合。空闲时是空操作，因此可以安全重试。 */
  interrupt(sessionID: string): Promise<void>
  isRunning(sessionID: string): boolean
  /** 取出会话句柄（必要时从磁盘加载） */
  handle(sessionID: string): Promise<SessionHandle>
  /** runner 注册唤醒回调 */
  setWakeHandler(handler: WakeHandler): void
  /** 关闭：中止所有运行中的回合 */
  shutdown(): Promise<void>
}

export const createSessionManager = (deps: SessionManagerDeps): SessionManager => {
  const logger = deps.logger ?? createLogger("session")
  const handles = new Map<string, SessionHandle>()
  let wakeHandler: WakeHandler | undefined

  const createHandle = (state: ProjectedState): SessionHandle => {
    const id = state.session.id
    const run: RunControl = { running: false }

    return {
      id,
      state,
      run,
      append: async (event: NewDurableEvent): Promise<DurableEvent> => {
        const stored = await deps.store.appendEvent(id, state.lastSeq + 1, event)
        applyEvent(state, stored)
        deps.hub.publish(stored)

        // 会话元信息变化时同步派生缓存，让侧边栏列表能立刻反映最新标题与用量。
        // 其它事件不影响列表展示，不需要付这次写盘成本。
        if (stored.type === "session.created" || stored.type === "session.updated") {
          await deps.store.writeSession(state.session)
        }

        return stored
      },
      readContext: () => deps.store.readContext(id),
      saveContext: (context) => deps.store.writeContext(id, context),
    }
  }

  const load = async (sessionID: string): Promise<SessionHandle> => {
    const cached = handles.get(sessionID)
    if (cached) return cached

    const session = await deps.store.readSession(sessionID)
    if (!session) throw new Error(`会话不存在：${sessionID}`)

    const events = await deps.store.readEvents(sessionID)
    const handle = createHandle(projectEvents(session, events))
    handles.set(sessionID, handle)

    // 进程上次退出时没跑完的回合必须在这里收尾，否则历史里会留下永远处于
    // pending 的工具调用和一张永远转圈的审批卡片，用户完全无法理解发生了什么
    await recoverInterruptedRun(handle)

    logger.debug("会话已加载", {
      sessionID,
      messageCount: handle.state.messages.length,
      lastSeq: handle.state.lastSeq,
    })
    return handle
  }

  const recoverInterruptedRun = async (handle: SessionHandle): Promise<void> => {
    const now = Date.now()
    let recoveredTools = 0
    let recoveredMessages = 0

    // 待审批请求：进程重启后已经没有代码在等待它，只能作废
    for (const request of [...handle.state.pendingPermissions.values()]) {
      await handle.append({
        type: "permission.replied",
        sessionID: handle.id,
        timestamp: now,
        requestID: request.id,
        reply: "reject",
        feedback: "进程重启，该审批请求已失效",
      })
    }

    for (const message of handle.state.messages) {
      if (message.role !== "assistant") continue

      for (const part of message.parts) {
        if (part.type !== "tool" || part.state.status !== "pending") continue
        await handle.append({
          type: "tool.settled",
          sessionID: handle.id,
          timestamp: now,
          callID: part.callID,
          status: "error",
          error: "工具执行被进程重启打断，未产生结果",
        })
        recoveredTools += 1
      }

      if (message.completedAt === undefined) {
        await handle.append({
          type: "message.ended",
          sessionID: handle.id,
          timestamp: now,
          messageID: message.id,
          finish: "interrupted",
        })
        recoveredMessages += 1
      }
    }

    if (recoveredTools > 0 || recoveredMessages > 0) {
      logger.warn("已收尾被中断的回合", { sessionID: handle.id, recoveredTools, recoveredMessages })
    }
  }

  const create = async (input: { directory: string; title?: string }): Promise<Session> => {
    const directory = resolve(expandHome(input.directory))
    await mkdir(directory, { recursive: true })

    const now = Date.now()
    const agent = deps.agents.default()
    const session: Session = {
      id: newSessionID(),
      title: input.title?.trim() || "新会话",
      directory,
      agent: agent.id,
      model: deps.config.model,
      createdAt: now,
      updatedAt: now,
      usage: zeroUsage(),
    }

    const handle = createHandle(createProjectedState(session))
    handles.set(session.id, handle)
    await handle.append({ type: "session.created", sessionID: session.id, timestamp: now, session })

    logger.info("已创建会话", {
      sessionID: session.id,
      directory,
      agent: agent.id,
      model: session.model,
    })
    return session
  }

  const prompt = async (sessionID: string, input: { text: string; delivery?: Delivery }) => {
    const handle = await load(sessionID)
    const text = input.text.trim()
    if (text.length === 0) throw new Error("输入内容不能为空")

    const inputID = newInputID()
    await handle.append({
      type: "input.admitted",
      sessionID: handle.id,
      timestamp: Date.now(),
      inputID,
      text,
      delivery: input.delivery ?? "steer",
    })

    // 唤醒执行。这里不 await：prompt 的语义是「持久化接纳 + 触发执行」，
    // 真正的执行进度通过事件流反馈给调用方
    wakeHandler?.(handle.id)

    return { inputID }
  }

  const interrupt = async (sessionID: string): Promise<void> => {
    const handle = handles.get(sessionID)
    if (!handle || !handle.run.running) {
      logger.debug("会话当前没有运行中的回合，中断请求已忽略", { sessionID })
      return
    }

    logger.info("收到中断请求", { sessionID })
    await handle.append({ type: "run.interrupted", sessionID, timestamp: Date.now() })
    handle.run.controller?.abort()

    // 等当前回合真正退出，否则调用方紧接着发起的下一轮会和它并发跑，
    // 造成两条助手消息交错写入同一段历史
    await handle.run.task?.catch(() => undefined)
  }

  const shutdown = async (): Promise<void> => {
    const running = [...handles.values()].filter((handle) => handle.run.running)
    if (running.length === 0) return
    logger.info("正在中止运行中的回合", { count: running.length })
    for (const handle of running) handle.run.controller?.abort()
    await Promise.allSettled(running.map((handle) => handle.run.task ?? Promise.resolve()))
  }

  return {
    list: () => deps.store.list(),
    create,
    get: (sessionID) => deps.store.readSession(sessionID),
    messages: async (sessionID) => [...(await load(sessionID)).state.messages],
    prompt,
    interrupt,
    isRunning: (sessionID) => handles.get(sessionID)?.run.running === true,
    handle: load,
    setWakeHandler: (handler) => {
      wakeHandler = handler
    },
    shutdown,
  }
}

/** 展开路径开头的 `~`，让 CLI 可以直接传 `~/easy_code`。 */
const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path
