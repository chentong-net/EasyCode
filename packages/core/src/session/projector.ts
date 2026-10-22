import type {
  Delivery,
  DurableEvent,
  Message,
  Part,
  PermissionRequest,
  Session,
  TaskState,
  ToolState,
} from "@easycode/schema"
import { addUsage, zeroUsage } from "@easycode/schema"

import { createLogger } from "../log.js"

const logger = createLogger("session.projector")

/**
 * 会话的内存投影状态。
 *
 * 事件日志是单一事实来源，这个对象是它重放并归约后的结果。之所以要在内存里维护而不是
 * 每次读盘，是因为每个 provider turn（模型调用轮次）都要读取「当前历史」和「待处理输入」，
 * 实时重放整个日志会让长会话变得很慢。
 */
export interface ProjectedState {
  session: Session
  messages: Message[]
  /** 已接纳但尚未转为可见消息的输入 */
  pendingInputs: Map<string, { text: string; delivery: Delivery }>
  /** 待审批的权限请求（已写入日志但还没收到回复的） */
  pendingPermissions: Map<string, PermissionRequest>
  /** 当前任务的显式工作记忆；没有新任务时为 undefined。 */
  task: TaskState | undefined
  /** 由持久事件投影出的最近回合运行状态。 */
  running: boolean
  /** 已消费的最大事件序号 */
  lastSeq: number
  /** 按 ID 索引消息，避免查找 part 时线性扫描 */
  messageIndex: Map<string, Message>
  /**
   * 消息 ID → 产生它的事件序号。
   *
   * 历史投影需要据此判断某条系统消息是否已经被折进 baseline（基线，序号 ≤ baselineSeq），
   * 消息本身不带序号，所以单独维护一张表。
   */
  messageSeq: Map<string, number>
  /** 工具调用 ID → 它所在的消息与 part 下标 */
  toolIndex: Map<string, { messageID: string; index: number }>
}

/** 创建一个空的投影状态。调用方需要先提供会话元信息，随后会被 session.created 覆盖。 */
export const createProjectedState = (session: Session): ProjectedState => ({
  session,
  messages: [],
  pendingInputs: new Map(),
  pendingPermissions: new Map(),
  task: undefined,
  running: false,
  lastSeq: 0,
  messageIndex: new Map(),
  messageSeq: new Map(),
  toolIndex: new Map(),
})

/** 重放并归约整条事件日志，得到当前投影状态。 */
export const projectEvents = (session: Session, events: DurableEvent[]): ProjectedState => {
  const state = createProjectedState(session)
  for (const event of events) applyEvent(state, event)
  return state
}

/**
 * 把一条事件应用到投影状态上。
 *
 * 这个函数必须是幂等的纯状态变换（不读盘、不发网络请求），
 * 这样「启动时重放日志」和「运行时增量追加」才能走完全相同的代码路径，
 * 避免出现「重启后行为和重启前不一致」这类最难排查的问题。
 */
export const applyEvent = (state: ProjectedState, event: DurableEvent): void => {
  state.lastSeq = Math.max(state.lastSeq, event.seq)

  switch (event.type) {
    case "session.created":
      state.session = event.session
      break

    case "session.updated": {
      const next: Session = { ...state.session }
      if (event.title !== undefined) next.title = event.title
      if (event.usage !== undefined) next.usage = event.usage
      if (event.pinnedAt !== undefined) {
        if (event.pinnedAt === null) delete next.pinnedAt
        else next.pinnedAt = event.pinnedAt
      }
      next.updatedAt = event.timestamp
      state.session = next
      break
    }

    case "session.failed":
      // 会话级失败只作为事件呈现给 UI，不改变投影出来的消息历史
      break

    case "session.todos":
      state.session = { ...state.session, todos: event.todos, updatedAt: event.timestamp }
      break

    case "task.updated":
      state.task = event.task
      break

    case "input.admitted":
      state.pendingInputs.set(event.inputID, { text: event.text, delivery: event.delivery })
      break

    case "input.promoted": {
      const input = state.pendingInputs.get(event.inputID)
      state.pendingInputs.delete(event.inputID)
      if (!input) {
        // 日志被截断时可能出现「只见转换、不见接纳」，此时文本已经无从得知
        logger.warn("输入转换事件找不到对应的接纳记录", { inputID: event.inputID })
      }
      pushMessage(
        state,
        {
          id: event.messageID,
          role: "user",
          createdAt: event.timestamp,
          parts: [{ type: "text", text: input?.text ?? "" }],
        },
        event.seq,
      )
      break
    }

    case "message.started":
      pushMessage(
        state,
        {
          id: event.messageID,
          role: "assistant",
          model: event.model,
          createdAt: event.timestamp,
          parts: [],
        },
        event.seq,
      )
      break

    case "part.text":
      setPart(state, event.messageID, event.index, { type: "text", text: event.text })
      break

    case "part.reasoning":
      setPart(state, event.messageID, event.index, { type: "reasoning", text: event.text })
      break

    case "tool.called":
      setPart(state, event.messageID, event.index, {
        type: "tool",
        callID: event.callID,
        name: event.name,
        input: event.input,
        state: { status: "pending" },
      })
      state.toolIndex.set(event.callID, { messageID: event.messageID, index: event.index })
      break

    case "tool.settled":
      settleTool(state, event.callID, toToolState(event))
      break

    case "message.ended": {
      const message = state.messageIndex.get(event.messageID)
      if (!message || message.role !== "assistant") {
        logger.warn("消息结束事件找不到对应的助手消息", { messageID: event.messageID })
        break
      }
      message.finish = event.finish
      message.completedAt = event.timestamp
      if (event.error !== undefined) message.error = event.error
      if (event.usage !== undefined) {
        message.usage = event.usage
        state.session = { ...state.session, usage: addUsage(state.session.usage, event.usage) }
      }
      break
    }

    case "compaction.ended":
      pushMessage(
        state,
        {
          id: event.messageID,
          role: "compaction",
          createdAt: event.timestamp,
          text: event.text,
          recentMessageIDs: event.recentMessageIDs,
        },
        event.seq,
      )
      break

    case "context.updated":
      pushMessage(
        state,
        {
          id: event.messageID,
          role: "system",
          createdAt: event.timestamp,
          text: event.text,
        },
        event.seq,
      )
      break

    case "permission.asked":
      state.pendingPermissions.set(event.requestID, {
        id: event.requestID,
        sessionID: event.sessionID,
        callID: event.callID,
        action: event.action,
        resources: event.resources,
        save: event.save,
        createdAt: event.timestamp,
      })
      break

    case "permission.replied":
      state.pendingPermissions.delete(event.requestID)
      break

    case "run.started":
      state.running = true
      break

    case "run.idle":
      state.running = false
      break

    case "run.interrupted":
      // 中断本身不改变历史，只作为事件告诉 UI「这一轮停了」
      break
  }
}

/** 把工具调用完成事件转换成投影里的工具状态。 */
const toToolState = (event: Extract<DurableEvent, { type: "tool.settled" }>): ToolState => {
  if (event.status === "success") {
    return {
      status: "success",
      output: event.output,
      content: event.content ?? [],
      outputPaths: event.outputPaths ?? [],
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    }
  }
  return {
    status: "error",
    error: event.error ?? "工具执行失败",
    ...(event.output === undefined ? {} : { output: event.output }),
    ...(event.content === undefined ? {} : { content: event.content }),
    ...(event.outputPaths === undefined ? {} : { outputPaths: event.outputPaths }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  }
}

/** 追加一条消息，并登记到索引里。 */
const pushMessage = (state: ProjectedState, message: Message, seq: number): void => {
  state.messages.push(message)
  state.messageIndex.set(message.id, message)
  state.messageSeq.set(message.id, seq)
}

/** 写入消息中指定下标的 part。下标由发布方在投影时分配，保证是连续递增的。 */
const setPart = (state: ProjectedState, messageID: string, index: number, part: Part): void => {
  const message = state.messageIndex.get(messageID)
  if (!message || message.role === "user" || message.role === "system" || message.role === "compaction") {
    logger.warn("part 事件找不到可写入的助手消息", { messageID, index, partType: part.type })
    return
  }
  message.parts[index] = part
}

/** 更新某个工具调用的执行状态。 */
const settleTool = (state: ProjectedState, callID: string, toolState: ToolState): void => {
  const location = state.toolIndex.get(callID)
  if (!location) {
    logger.warn("工具调用完成事件找不到对应的调用记录", { callID })
    return
  }

  const message = state.messageIndex.get(location.messageID)
  if (!message || message.role !== "assistant") return

  const part = message.parts[location.index]
  if (!part || part.type !== "tool") return

  message.parts[location.index] = { ...part, state: toolState }
}

/**
 * 计算会话的下一批 part 下标。
 *
 * 发布方每写一个新的 part 都需要知道该用哪个下标。规则很简单：
 * 取当前 parts 数组长度，因为 part 只在末尾追加。
 */
export const nextPartIndex = (message: Message): number => ("parts" in message ? message.parts.length : 0)

/** 取出某个会话中所有尚未转为可见消息的输入，按接纳顺序排列。 */
export const pendingInputList = (state: ProjectedState): Array<{ inputID: string; text: string; delivery: Delivery }> =>
  [...state.pendingInputs.entries()].map(([inputID, value]) => ({ inputID, ...value }))

/** 会话累计用量的兜底值，用于日志与 UI 展示。 */
export const sessionUsage = (state: ProjectedState) => state.session.usage ?? zeroUsage()
