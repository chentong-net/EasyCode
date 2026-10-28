import type { EasyCodeClient } from "@easycode/client"
import {
  isDurableEvent,
  type Event,
  type Message,
  type PermissionReply,
  type PermissionRequest,
  type Session,
} from "@easycode/schema"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { describeError } from "./format"

/**
 * 界面的会话状态。
 *
 * 核心决策：**界面不自己实现一遍事件投影**。
 *
 * Core 里已经有一条「事件日志 → 消息列表」的投影规则，如果界面为了实时显示
 * 再实现一遍，两份实现迟早会因为某次改动而分叉，症状是「刷新一下就好了」这类
 * 最难排查的问题。这里的做法是：
 *
 * - 持久化事件到达 → 延迟一小段时间后重新向 Core 拉取投影结果
 *   （延迟是为了把一次回合里的高频事件合并成一次请求）
 * - 流式增量 → 直接叠加在拉取结果之上，因为它本来就是「还没落盘的临时内容」
 *
 * 代价是每次回合结束前会有若干次本地 HTTP 请求。这些请求不落磁盘
 * （会话已经在内存里），代价远小于维护两套投影逻辑。
 */

/** 事件到达后延迟多久重新拉取。80ms 足够把一次工具调用的多条事件合并成一批。 */
const REFETCH_DELAY_MS = 80

/** 流式增量缓冲。同一时刻只可能有一条助手消息在生成，因此只保存一条。 */
interface DeltaBuffer {
  messageID: string
  /** part 下标 → 该 part 已累积的文本 */
  parts: Map<number, { kind: "text" | "reasoning"; text: string }>
}

export type CompactionViewState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "completed"; completedAt: number; degraded: boolean }
  | { phase: "failed"; completedAt: number }

export interface EasyCodeStore {
  /** 全部工作区下的会话，供侧边栏分组。 */
  allSessions: Session[]
  /** 当前工作目录下的会话，置顶优先，其次按最近活跃时间倒序 */
  sessions: Session[]
  currentSessionID: string | undefined
  currentSession: Session | undefined
  /** 当前会话的对话消息（只含用户与助手），已叠加流式增量 */
  messages: Message[]
  /** 回合是否正在运行 */
  running: boolean
  /** 待用户回应的授权请求 */
  pendingPermissions: PermissionRequest[]
  /** 当前会话最近一次上下文压缩的展示状态。 */
  compaction: CompactionViewState
  /** 当前记录的事件流连通状态；自动重连中的瞬时断开目前不会翻转此值。 */
  connected: boolean
  loading: boolean
  error: string | undefined
  /** 模型上下文窗口大小，用于把 token 占用显示成比例 */
  contextWindow: number | undefined
  /** 单轮回复的输出预留，用于算出「可用额度」 */
  maxOutputTokens: number | undefined

  selectSession(sessionID: string): void
  /** 进入未持久化的新会话页面；首次发送时才创建会话。 */
  startNewSession(): void
  pinSession(sessionID: string, pinned: boolean): Promise<void>
  deleteSession(sessionID: string): Promise<void>
  send(text: string): Promise<void>
  interrupt(): Promise<void>
  replyPermission(requestID: string, reply: PermissionReply, feedback?: string): Promise<void>
  clearError(): void
}

export const useEasyCode = (client: EasyCodeClient, workspace: string | undefined): EasyCodeStore => {
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionID, setCurrentSessionID] = useState<string | undefined>()
  const [currentSession, setCurrentSession] = useState<Session | undefined>()
  const [messages, setMessages] = useState<Message[]>([])
  const [deltas, setDeltas] = useState<DeltaBuffer | undefined>()
  const [running, setRunning] = useState(false)
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([])
  const [compaction, setCompaction] = useState<CompactionViewState>({ phase: "idle" })
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  /** 自增即可触发会话列表重新拉取，比在每次变更处手写更新逻辑更不容易漏 */
  const [sessionListToken, setSessionListToken] = useState(0)
  const loadedWorkspace = useRef<string | undefined>(undefined)
  const listRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepNoSelection = useRef(true)
  const [contextWindow, setContextWindow] = useState<number | undefined>()
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | undefined>()

  /** 只保留当前工作目录下的会话。切换到别的目录后，列表应当完全换一批。 */
  const scopedSessions = useMemo(
    () => (workspace === undefined ? [] : sessions.filter((session) => session.directory === workspace)),
    [sessions, workspace],
  )

  /**
   * 真正可以操作的会话。
   *
   * 与状态里的 `currentSessionID` 差一层校验：切换工作目录后、新列表还没回来之前，
   * 原来选中的会话已经不属于当前目录了。这时不能继续拿它去拉消息或推送输入，
   * 否则界面会短暂显示另一个目录下会话的内容。
   */
  const activeSessionID = useMemo(
    () => (scopedSessions.some((session) => session.id === currentSessionID) ? currentSessionID : undefined),
    [scopedSessions, currentSessionID],
  )

  const refreshSessionListSoon = useCallback(() => {
    if (listRefreshTimer.current !== undefined) clearTimeout(listRefreshTimer.current)
    listRefreshTimer.current = setTimeout(() => {
      listRefreshTimer.current = undefined
      setSessionListToken((token) => token + 1)
    }, 150)
  }, [])

  useEffect(
    () => () => {
      if (listRefreshTimer.current !== undefined) clearTimeout(listRefreshTimer.current)
    },
    [],
  )

  /* ---------------------------------------------------------------------- */
  /* 运行环境信息                                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        // 上下文窗口与输出预留都是模型的固有属性，进程生命周期内不会变，拉一次即可
        const health = await client.health(controller.signal)
        if (controller.signal.aborted) return
        setContextWindow(health.contextWindow)
        setMaxOutputTokens(health.maxOutputTokens)
      } catch (cause) {
        // 拿不到不影响使用，只是用量显示退化成只有绝对数字
        if (!controller.signal.aborted) console.warn("[easycode] 无法获取模型信息", cause)
      }
    })()
    return () => controller.abort()
  }, [client])

  /* ---------------------------------------------------------------------- */
  /* 会话列表                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (workspace === undefined) {
      // 还没选工作目录：没有会话可列，也不该去请求
      setSessions([])
      setLoading(false)
      loadedWorkspace.current = undefined
      keepNoSelection.current = false
      return
    }

    const controller = new AbortController()
    const workspaceChanged = loadedWorkspace.current !== undefined && loadedWorkspace.current !== workspace
    if (workspaceChanged) keepNoSelection.current = false
    const initialLoad = loadedWorkspace.current !== workspace
    if (initialLoad) setLoading(true)

    void (async () => {
      try {
        const list = await client.sessions.list(controller.signal)
        if (controller.signal.aborted) return

        const scoped = list.filter((session) => session.directory === workspace)
        setSessions(sortSessions(list))
        loadedWorkspace.current = workspace
        setLoading(false)
        // 切换到别的目录后，原来选中的会话已经不在这批里，改为打开该目录下最近的一个；
        // 只是同目录内刷新（例如标题变了）则保留用户当前的选择
        setCurrentSessionID((previous) =>
          previous !== undefined && scoped.some((session) => session.id === previous)
            ? previous
            : keepNoSelection.current
              ? undefined
              : scoped[0]?.id,
        )
      } catch (cause) {
        if (controller.signal.aborted) return
        setError(describeError(cause))
        if (initialLoad) setLoading(false)
      }
    })()

    return () => controller.abort()
  }, [client, sessionListToken, workspace])

  /* ---------------------------------------------------------------------- */
  /* 当前会话：初次拉取 + 事件订阅                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (activeSessionID === undefined) {
      setMessages([])
      setDeltas(undefined)
      setCurrentSession(undefined)
      setPendingPermissions([])
      setRunning(false)
      setCompaction({ phase: "idle" })
      return
    }

    const controller = new AbortController()
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** 是否已有一次拉取在飞。有的话把新的请求合并为「结束后再拉一次」。 */
    let inFlight = false
    let again = false
    let runActive = false
    let listDirty = false
    let activeCompactionID: string | undefined

    // 切换会话时先清空派生状态。事件的完整重放会把它们重新填对，
    // 不清的话会短暂显示上一个会话的运行状态与审批卡片
    setDeltas(undefined)
    setRunning(false)
    setPendingPermissions([])
    setCompaction({ phase: "idle" })

    const load = async (): Promise<void> => {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      try {
        const [nextMessages, nextPermissions, nextSession] = await Promise.all([
          client.sessions.messages(activeSessionID),
          client.sessions.permissions(activeSessionID),
          client.sessions.get(activeSessionID),
        ])
        if (disposed) return
        setMessages(nextMessages)
        setPendingPermissions(nextPermissions)
        setCurrentSession(nextSession)
      } catch (cause) {
        if (!disposed) setError(describeError(cause))
      } finally {
        inFlight = false
        if (again) {
          again = false
          void load()
        }
      }
    }

    /** 合并短时间内的多次重建请求。 */
    const scheduleLoad = (delay = REFETCH_DELAY_MS): void => {
      if (disposed || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void load()
      }, delay)
    }

    /** 立刻重建，并丢弃尚在等待的延迟任务。 */
    const loadNow = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      void load()
    }

    const appendDelta = (messageID: string, index: number, kind: "text" | "reasoning", text: string): void => {
      setDeltas((previous) => {
        const base = previous !== undefined && previous.messageID === messageID ? previous : undefined
        const parts = new Map(base?.parts ?? [])
        parts.set(index, { kind, text: (parts.get(index)?.text ?? "") + text })
        return { messageID, parts }
      })
    }

    const handleEvent = (event: Event): void => {
      // 能收到事件就说明链路是通的（包括自动重连成功之后）
      setConnected(true)

      if (!isDurableEvent(event)) {
        switch (event.type) {
          case "text.delta":
            appendDelta(event.messageID, event.index, "text", event.text)
            return
          case "reasoning.delta":
            appendDelta(event.messageID, event.index, "reasoning", event.text)
            return
          case "tool.input.delta":
            // 工具入参的实时分片不展示：权威值很快会随 tool.called 一起到达
            return
        }
        return
      }

      switch (event.type) {
        case "run.started":
          runActive = true
          setRunning(true)
          return

        case "run.idle":
          // 回合彻底结束：丢掉流式缓冲，并立刻同步一次最终结果
          runActive = false
          setRunning(false)
          setDeltas(undefined)
          if (activeCompactionID !== undefined) {
            activeCompactionID = undefined
            setCompaction({ phase: "failed", completedAt: event.timestamp })
          }
          loadNow()
          if (listDirty) {
            listDirty = false
            refreshSessionListSoon()
          }
          return

        case "compaction.started":
          activeCompactionID = event.compactionID
          setCompaction({ phase: "running", startedAt: event.timestamp })
          return

        case "compaction.ended":
          activeCompactionID = undefined
          setCompaction({
            phase: "completed",
            completedAt: event.timestamp,
            degraded: event.usedFallback === true || event.reason === "fallback",
          })
          scheduleLoad()
          return

        case "compaction.failed":
          activeCompactionID = undefined
          setCompaction({ phase: "failed", completedAt: event.timestamp })
          scheduleLoad()
          return

        case "permission.asked":
        case "permission.replied":
          // 审批状态需要尽快反映到界面上，不能等延迟合并
          scheduleLoad(0)
          return

        case "session.updated":
        case "session.todos":
          if (runActive) listDirty = true
          else refreshSessionListSoon()
          scheduleLoad()
          return

        default:
          scheduleLoad()
      }
    }

    void (async () => {
      try {
        // async generator 在首次迭代时才建立 SSE 连接；这里先拉取投影，
        // 后续连接会从头重放持久化事件，由事件处理补齐拉取期间的变化
        const stream = client.sessions.events(activeSessionID, { signal: controller.signal })
        await load()
        if (disposed) return

        for await (const event of stream) {
          if (disposed) break
          handleEvent(event)
        }
      } catch (cause) {
        if (disposed || controller.signal.aborted) return
        // 客户端会自动重连，这里只把状态反映到界面上
        setConnected(false)
        setError(describeError(cause))
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, activeSessionID, refreshSessionListSoon])

  /* ---------------------------------------------------------------------- */
  /* 对外动作                                                                */
  /* ---------------------------------------------------------------------- */

  const selectSession = useCallback((sessionID: string) => {
    keepNoSelection.current = false
    setError(undefined)
    setCurrentSessionID(sessionID)
  }, [])

  const startNewSession = useCallback(() => {
    keepNoSelection.current = true
    setError(undefined)
    setCurrentSessionID(undefined)
  }, [])

  const pinSession = useCallback(
    async (sessionID: string, pinned: boolean) => {
      try {
        const updated = await client.sessions.pin(sessionID, { pinned })
        setSessions((previous) =>
          sortSessions(previous.map((session) => (session.id === sessionID ? updated : session))),
        )
        if (activeSessionID === sessionID) setCurrentSession(updated)
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [client, activeSessionID],
  )

  const deleteSession = useCallback(
    async (sessionID: string) => {
      try {
        if (activeSessionID === sessionID && running) await client.sessions.interrupt(sessionID)
        await client.sessions.delete(sessionID)
        setSessions((previous) => previous.filter((session) => session.id !== sessionID))
        if (activeSessionID === sessionID) {
          keepNoSelection.current = true
          setCurrentSessionID(undefined)
        }
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [client, activeSessionID, running],
  )

  const send = useCallback(
    async (text: string) => {
      if (workspace === undefined) return
      try {
        let sessionID = activeSessionID
        if (sessionID === undefined) {
          const session = await client.sessions.create({ directory: workspace })
          keepNoSelection.current = false
          setSessions((previous) => sortSessions([session, ...previous]))
          setCurrentSession(session)
          setCurrentSessionID(session.id)
          sessionID = session.id
        }
        await client.sessions.prompt(sessionID, { text })
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [activeSessionID, client.sessions, workspace],
  )

  const interrupt = useCallback(async () => {
    if (activeSessionID === undefined) return
    try {
      await client.sessions.interrupt(activeSessionID)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [client, activeSessionID])

  const replyPermission = useCallback(
    async (requestID: string, reply: PermissionReply, feedback?: string) => {
      if (activeSessionID === undefined) return
      try {
        await client.sessions.replyPermission(activeSessionID, requestID, {
          reply,
          ...(feedback === undefined ? {} : { feedback }),
        })
        // 本地先摘掉卡片，避免用户重复点击；随后的事件会把状态对齐
        setPendingPermissions((previous) => previous.filter((request) => request.id !== requestID))
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [client, activeSessionID],
  )

  const clearError = useCallback(() => setError(undefined), [])

  /* ---------------------------------------------------------------------- */
  /* 派生数据                                                                */
  /* ---------------------------------------------------------------------- */

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message): message is Extract<Message, { role: "user" | "assistant" }> =>
          message.role === "user" || message.role === "assistant",
      ),
    [messages],
  )

  const mergedMessages = useMemo(() => mergeDeltas(visibleMessages, deltas), [visibleMessages, deltas])

  return {
    allSessions: sessions,
    sessions: scopedSessions,
    currentSessionID: activeSessionID,
    currentSession,
    messages: mergedMessages,
    running,
    pendingPermissions,
    compaction,
    connected,
    loading,
    error,
    contextWindow,
    maxOutputTokens,
    selectSession,
    startNewSession,
    pinSession,
    deleteSession,
    send,
    interrupt,
    replyPermission,
    clearError,
  }
}

const sortSessions = (sessions: Session[]): Session[] =>
  [...sessions].sort((a, b) => {
    if (a.pinnedAt !== undefined || b.pinnedAt !== undefined) {
      if (a.pinnedAt === undefined) return 1
      if (b.pinnedAt === undefined) return -1
      if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt
    }
    return b.updatedAt - a.updatedAt
  })

/**
 * 把流式增量叠加到已投影的消息上。
 *
 * 冲突规则：同一个 part 同时有权威值与增量时取更长的那个。
 * 权威值（落盘的 part）一定不比增量短，因为它是在增量结束后写下的；
 * 增量在长回复过程中是唯一的数据来源，因为此时 part 还没有落盘。
 * 取较长者让这两个阶段的切换不会出现文字回退。
 */
const mergeDeltas = (messages: Message[], deltas: DeltaBuffer | undefined): Message[] => {
  if (deltas === undefined) return messages

  const index = messages.findIndex((message) => message.id === deltas.messageID)
  if (index === -1) return messages

  const message = messages[index]
  if (message === undefined || message.role !== "assistant") return messages

  const parts = [...message.parts]
  for (const [partIndex, delta] of deltas.parts) {
    const existing = parts[partIndex]
    const authoritative =
      existing !== undefined && (existing.type === "text" || existing.type === "reasoning") ? existing.text : ""
    const text = authoritative.length >= delta.text.length ? authoritative : delta.text
    parts[partIndex] = delta.kind === "text" ? { type: "text", text } : { type: "reasoning", text }
  }

  const merged = [...messages]
  merged[index] = { ...message, parts }
  return merged
}
