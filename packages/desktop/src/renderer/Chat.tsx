import type { Message, PermissionRequest, Usage } from "@easycode/schema"
import { useEffect, useMemo, useRef } from "react"

import { Composer } from "./composer"
import { formatTokens, usageTotal } from "./format"
import { MessageView } from "./message-view"
import type { EasyCodeStore } from "./store"
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
  quota: number | undefined
  used: number | undefined
  ratio: number | undefined
}

const buildUsageView = (size: number | undefined, reserve: number | undefined, usage: Usage | undefined): UsageView => {
  const quota = size !== undefined && reserve !== undefined && reserve < size ? size - reserve : undefined
  const used = usage === undefined ? undefined : usageTotal(usage)
  const ratio = used !== undefined && quota !== undefined && quota > 0 ? Math.min(1, used / quota) : undefined
  return { size, quota, used, ratio }
}

const StatusBar = ({ store, contextUsage }: { store: EasyCodeStore; contextUsage: Usage | undefined }) => {
  const view = buildUsageView(store.contextWindow, store.maxOutputTokens, contextUsage)
  const windowLabel = view.size === undefined ? "—" : formatTokens(view.size)
  const quotaLabel = view.quota === undefined ? "—" : formatTokens(view.quota)

  const usageLine =
    view.ratio !== undefined && view.used !== undefined
      ? `上下文 ${formatTokens(view.used)} / 额度 ${quotaLabel}（窗口 ${windowLabel}）`
      : `上下文 — / 额度 ${quotaLabel}（窗口 ${windowLabel}）`

  const statusLine = !store.connected
    ? "与服务端的连接已断开，正在自动重连…"
    : view.ratio !== undefined
      ? "自动 compaction（压缩）已就绪"
      : `自动 compaction（压缩）已就绪：窗口 ${windowLabel}，发第一条消息后这里显示占用`

  return (
    <div className="status-bar">
      <ContextRing ratio={view.ratio ?? 0} hasValue={view.ratio !== undefined} />
      <div className="status-text">
        <div className="status-usage">{usageLine}</div>
        <div className={`status-note${store.connected ? "" : " status-note-warn"}`}>{statusLine}</div>
      </div>
    </div>
  )
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

  if (workspace.directory === undefined) {
    return (
      <main className="chat">
        <div className="placeholder">
          <p className="placeholder-text">还没有工作目录</p>
          <button type="button" className="btn" onClick={() => void workspace.select()} disabled={workspace.selecting}>
            {workspace.selecting ? "请在弹出的窗口中选择…" : "选择工作目录"}
          </button>
        </div>
      </main>
    )
  }

  if (store.currentSessionID === undefined) {
    if (!store.loading && store.sessions.length > 0) {
      return <main className="chat" aria-label="未选择会话" />
    }
    return (
      <main className="chat">
        <div className="placeholder">
          <p className="placeholder-text">{store.loading ? "正在加载…" : "还没有会话"}</p>
          {!store.loading && (
            <button type="button" className="btn" onClick={() => void store.createSession()}>
              新建会话
            </button>
          )}
        </div>
      </main>
    )
  }

  return (
    <main className="chat">
      <Conversation store={store} />
      <StatusBar store={store} contextUsage={contextUsage} />
    </main>
  )
}
