import type { Message, PermissionRequest, Usage } from "@easycode/schema"
import { useEffect, useMemo, useRef, useState } from "react"

import { Composer } from "./composer"
import { formatTokens, usageTotal } from "./format"
import { MessageView } from "./message-view"
import { type CompactionViewState, type EasyCodeStore } from "./store"
import type { WorkspaceState } from "./workspace"

const PermissionCard = ({
  request,
  onReply,
}: {
  request: PermissionRequest
  onReply: (requestID: string, reply: "once" | "always" | "reject") => void
}) => (
  <div className="permission-card">
    <div className="permission-title">需要你的授权</div>
    <div className="permission-action">{request.action}</div>
    <div className="permission-resources">
      {request.resources.map((resource) => (
        <code key={resource}>{resource}</code>
      ))}
    </div>
    <div className="permission-actions">
      <button type="button" className="btn" onClick={() => onReply(request.id, "once")}>
        仅本次允许
      </button>
      {request.save.length > 0 && (
        <button type="button" className="btn" onClick={() => onReply(request.id, "always")}>
          总是允许
        </button>
      )}
      <button type="button" className="btn btn-danger" onClick={() => onReply(request.id, "reject")}>
        拒绝
      </button>
    </div>
  </div>
)

const ContextRing = ({ ratio, hasValue }: { ratio: number; hasValue: boolean }) => {
  const radius = 15
  const circumference = 2 * Math.PI * radius
  const filled = hasValue ? circumference * ratio : 0
  const tone = ratio >= 0.85 ? "danger" : ratio >= 0.6 ? "warn" : "normal"

  return (
    <div className={`context-ring context-ring-${tone}`} title={hasValue ? undefined : "发第一条消息后显示占用"}>
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
        <circle cx="18" cy="18" r={radius} fill="none" stroke="currentColor" strokeWidth="3" opacity="0.16" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="context-ring-label">{hasValue ? `${Math.round(ratio * 100)}%` : "—"}</span>
    </div>
  )
}

interface UsageView {
  size: number | undefined
  used: number | undefined
  ratio: number | undefined
}

const buildUsageView = (size: number | undefined, usage: Usage | undefined): UsageView => {
  const used = usage === undefined ? undefined : usageTotal(usage)
  const ratio = used !== undefined && size !== undefined && size > 0 ? Math.min(1, used / size) : undefined
  return { size, used, ratio }
}

const StatusBar = ({ store, contextUsage }: { store: EasyCodeStore; contextUsage: Usage | undefined }) => {
  const now = useMinuteClock(store.compaction)
  const view = buildUsageView(store.contextWindow, contextUsage)
  const windowLabel = view.size === undefined ? "—" : formatTokens(view.size)
  const percent = view.ratio === undefined ? undefined : Math.round(view.ratio * 100)
  const usageLine =
    view.used !== undefined && percent !== undefined
      ? `上下文 ${formatTokens(view.used)} / ${windowLabel}（${percent}%）`
      : `上下文 — / ${windowLabel}`
  const compaction = describeCompaction(store.compaction, now)
  const statusLine = store.connected ? compaction.text : "与服务端的连接已断开，正在自动重连…"
  const statusTone = store.connected ? compaction.tone : "warn"

  return (
    <div
      className="status-bar"
      title={
        store.maxOutputTokens === undefined
          ? undefined
          : `单轮输出预留 ${formatTokens(store.maxOutputTokens)}；上下文压缩还会保留额外安全余量`
      }
    >
      <ContextRing ratio={view.ratio ?? 0} hasValue={view.ratio !== undefined} />
      <div className="status-text">
        <div className="status-usage">{usageLine}</div>
        <div className={`status-note status-note-${statusTone}`} role="status" aria-live="polite">
          {store.connected && compaction.tone !== "normal" && (
            <span className={`compaction-dot compaction-dot-${compaction.tone}`} aria-hidden />
          )}
          <span>{statusLine}</span>
        </div>
      </div>
    </div>
  )
}

type StatusTone = "normal" | "running" | "degraded" | "failed" | "warn"

const describeCompaction = (
  state: CompactionViewState,
  now: number,
): { text: string; tone: StatusTone } => {
  switch (state.phase) {
    case "idle":
      return { text: "暂无上下文压缩记录", tone: "normal" }
    case "running":
      return { text: "正在压缩上下文", tone: "running" }
    case "failed":
      return { text: `上下文压缩失败：${formatAbsoluteTime(state.completedAt)}`, tone: "failed" }
    case "completed": {
      if (state.degraded) {
        return {
          text: `上次上下文压缩：${formatAbsoluteTime(state.completedAt)}（模型摘要不可用，触发降级策略）`,
          tone: "degraded",
        }
      }
      const age = Math.max(0, now - state.completedAt)
      if (age < 60_000) return { text: "刚刚完成上下文压缩", tone: "normal" }
      if (age < 3_600_000) {
        return { text: `${Math.max(1, Math.floor(age / 60_000))} 分钟前完成上下文压缩`, tone: "normal" }
      }
      return { text: `上次上下文压缩：${formatAbsoluteTime(state.completedAt)}`, tone: "normal" }
    }
  }
}

const useMinuteClock = (state: CompactionViewState): number => {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (state.phase !== "completed" || state.degraded) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [state])

  return now
}

const formatAbsoluteTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const useContextUsage = (messages: Message[]): Usage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant" && message.usage !== undefined) return message.usage
  }
  return undefined
}

const Conversation = ({ store }: { store: EasyCodeStore }) => {
  const viewport = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const hasConversation = store.messages.length > 0

  useEffect(() => {
    stickToBottom.current = true
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
  }, [store.currentSessionID])

  useEffect(() => {
    if (!stickToBottom.current) return
    const element = viewport.current
    if (!element) return
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [store.messages, store.running])

  const onScroll = (): void => {
    const element = viewport.current
    if (!element) return
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96
  }

  return (
    <section className={hasConversation ? "thread" : "thread thread-empty"}>
      <div
        ref={viewport}
        className="thread-viewport"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={store.running}
        onScroll={onScroll}
      >
        {!hasConversation && <h1 className="hero-title">今天想让我做点什么？</h1>}
        {store.messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
      </div>

      <div className="composer-area">
        {store.pendingPermissions.map((request) => (
          <PermissionCard
            key={request.id}
            request={request}
            onReply={(requestID, reply) => void store.replyPermission(requestID, reply)}
          />
        ))}
        <Composer
          running={store.running}
          onSend={async (text) => {
            stickToBottom.current = true
            await store.send(text)
          }}
          onStop={store.interrupt}
        />
      </div>
    </section>
  )
}

export const Chat = ({ store, workspace }: { store: EasyCodeStore; workspace: WorkspaceState }) => {
  const contextUsage = useMemo(() => useContextUsage(store.messages), [store.messages])
  const title = store.currentSession?.title ?? "EasyCode"

  if (workspace.directory === undefined) {
    return (
      <main className="chat">
        <ChatHeader title={title} />
        <div className="placeholder">
          <p className="placeholder-text">还没有工作区</p>
          <button type="button" className="btn" onClick={() => void workspace.select()} disabled={workspace.selecting}>
            {workspace.selecting ? "请在弹出的窗口中选择…" : "添加工作区"}
          </button>
        </div>
      </main>
    )
  }

  if (store.currentSessionID === undefined) {
    if (!store.loading && store.sessions.length > 0) {
      return (
        <main className="chat" aria-label="未选择会话">
          <ChatHeader title={title} />
        </main>
      )
    }
    return (
      <main className="chat">
        <ChatHeader title={title} />
        <div className="placeholder">
          <p className="placeholder-text">{store.loading ? "正在加载…" : "还没有会话"}</p>
          {!store.loading && (
            <button type="button" className="btn" onClick={store.startNewSession}>
              新会话
            </button>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="chat">
      <ChatHeader title={title} />
      <Conversation store={store} />
      <StatusBar store={store} contextUsage={contextUsage} />
    </main>
  )
}

const ChatHeader = ({ title }: { title: string }) => (
  <header className="chat-header">
    <span className="chat-header-title">{title}</span>
  </header>
)
