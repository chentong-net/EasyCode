import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import type { Delivery, DurableEvent, Message, Session } from "@easycode/schema"
import { zeroUsage } from "@easycode/schema"

import type { AgentRegistry } from "../agent.js"
import type { CoreConfig } from "../config.js"
import type { EventHub } from "../events.js"
import { newInputID, newSessionID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { expandHome } from "../util/path.js"
import { applyEvent, createProjectedState, projectEvents, type ProjectedState } from "./projector.js"
import type { NewDurableEvent, PersistedContext, SessionStore } from "./store.js"
import { finishTask, moveTaskPhase } from "./task.js"

/** 一个已加载到内存的会话。 */
export interface SessionHandle {
  readonly id: string
  /** 内存投影状态。只读使用，写操作一律通过 append 走事件日志。 */
  readonly state: ProjectedState

  /** 追加一条持久化事件：分配序号 → 落盘 → 更新投影 → 广播 → 必要时同步会话缓存 */
  append(event: NewDurableEvent): Promise<DurableEvent>
  readContext(): Promise<PersistedContext | undefined>
  saveContext(context: PersistedContext): Promise<void>
}

/**
 * 执行驱动。
 *
 * 会话管理器负责「持久化与投影」，具体「怎么跑一个回合」交给驱动实现。
 * 两者通过这个接口解耦，好处是管理器不需要知道 agent 循环的存在，
 * 而 runner 也只需要依赖几句抽象：唤醒、中断、查询是否在跑。
 *
 * `wake` 必须是同步返回的，且要在任何 await 之前登记好取消控制器：
 * 否则「用户发完消息立刻点中断」时，中断请求会看到「当前没在运行」而被丢弃。
 */
export interface RunDriver {
  wake(sessionID: string): void
  interrupt(sessionID: string): Promise<void>
  isRunning(sessionID: string): boolean
  shutdown(): Promise<void>
}

export interface SessionManagerDeps {
  config: CoreConfig
  store: SessionStore
  hub: EventHub
  agents: AgentRegistry
  logger?: Logger
}

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
  /** 置顶或取消置顶会话。 */
  pin(sessionID: string, pinned: boolean): Promise<Session>
  /** 修改会话标题，不改变会话目录或历史消息。 */
  rename(sessionID: string, title: string): Promise<Session>
  /** 永久删除会话；运行中的会话会先被中断。 */
  delete(sessionID: string): Promise<void>
  isRunning(sessionID: string): boolean
  /** 取出会话句柄（必要时从磁盘加载） */
  handle(sessionID: string): Promise<SessionHandle>
  /** 注册执行驱动 */
  setRunDriver(driver: RunDriver): void
  /** 关闭：中止所有运行中的回合 */
  shutdown(): Promise<void>
}

export const createSessionManager = (deps: SessionManagerDeps): SessionManager => {
  const logger = deps.logger ?? createLogger("session")
  const handles = new Map<string, SessionHandle>()
  let driver: RunDriver | undefined

  const createHandle = (state: ProjectedState): SessionHandle => {
    const id = state.session.id

    return {
      id,
      state,
      append: async (event: NewDurableEvent): Promise<DurableEvent> => {
        const stored = await deps.store.appendEvent(id, state.lastSeq + 1, event)
        applyEvent(state, stored)
        deps.hub.publish(stored)

        // 会话元信息变化时同步派生缓存，让侧边栏列表能立刻反映最新标题与用量。
        // 其它事件（文本增量、工具调用等）不影响列表展示，不必付这次写盘成本。
        if (
          stored.type === "session.created" ||
          stored.type === "session.updated" ||
          stored.type === "session.todos" ||
          stored.type === "message.ended"
        ) {
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
    const wasRunning = handle.state.running
    let recoveredTools = 0
    let recoveredMessages = 0

    if (handle.state.activeCompactionID !== undefined) {
      const compactionID = handle.state.activeCompactionID
      await handle.append({
        type: "compaction.failed",
        sessionID: handle.id,
        timestamp: now,
        compactionID,
        reason: "error",
      })
    }

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
          error: "该消息未正常结束（进程重启）",
        })
        recoveredMessages += 1
      }
    }

    if (recoveredTools > 0 || recoveredMessages > 0) {
      logger.warn("已收尾被中断的回合", { sessionID: handle.id, recoveredTools, recoveredMessages })
    }

    const task = handle.state.task
    if (wasRunning && task && !task.outcome) {
      await handle.append({
        type: "task.updated",
        sessionID: handle.id,
        timestamp: now,
        task: finishTask(moveTaskPhase(task, "blocked"), {
          status: "blocked",
          summary: "进程在任务执行期间退出，任务未能正常完成。",
          remaining: ["重新发送任务或根据已有结果继续处理。"],
          timestamp: now,
        }),
      })
    }
  }

  const create = async (input: { directory: string; title?: string }): Promise<Session> => {
    const directory = resolve(expandHome(input.directory))
    await mkdir(directory, { recursive: true })

    const now = Date.now()
    const agent = deps.agents.default()
    const session: Session = {
      id: newSessionID(),
      title: input.title?.trim() || DEFAULT_SESSION_TITLE,
      directory,
      agent: agent.id,
      model: deps.config.model,
      createdAt: now,
      updatedAt: now,
      usage: zeroUsage(),
      todos: [],
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
    driver?.wake(handle.id)

    return { inputID }
  }

  return {
    list: () => deps.store.list(),
    create,
    get: (sessionID) => deps.store.readSession(sessionID),
    messages: async (sessionID) => [...(await load(sessionID)).state.messages],
    prompt,
    interrupt: async (sessionID) => {
      if (!driver) return
      await driver.interrupt(sessionID)
    },
    pin: async (sessionID, pinned) => {
      const handle = await load(sessionID)
      await handle.append({
        type: "session.updated",
        sessionID,
        timestamp: Date.now(),
        pinnedAt: pinned ? Date.now() : null,
      })
      return handle.state.session
    },
    rename: async (sessionID, input) => {
      const title = input.trim()
      if (title.length === 0) throw new Error("会话标题不能为空")
      const handle = await load(sessionID)
      await handle.append({
        type: "session.updated",
        sessionID,
        timestamp: Date.now(),
        title,
      })
      return handle.state.session
    },
    delete: async (sessionID) => {
      if (driver?.isRunning(sessionID)) await driver.interrupt(sessionID)
      await deps.store.deleteSession(sessionID)
      handles.delete(sessionID)
      logger.info("已删除会话", { sessionID })
    },
    isRunning: (sessionID) => driver?.isRunning(sessionID) ?? false,
    handle: load,
    setRunDriver: (next) => {
      driver = next
    },
    shutdown: async () => {
      await driver?.shutdown()
    },
  }
}

/** 新会话的默认标题。首次输入转为可见消息时会被替换成截断后的输入内容。 */
export const DEFAULT_SESSION_TITLE = "新会话"
