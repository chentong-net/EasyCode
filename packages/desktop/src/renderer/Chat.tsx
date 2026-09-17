import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react"
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown"
import type { Message, PermissionRequest, Usage } from "@easycode/schema"
import { useMemo, useState } from "react"

import { formatTokens, summarizeToolInput, usageTotal } from "./format"
import type { EasyCodeStore } from "./store"
import type { ToolResultView } from "./thread-message"

/**
 * 对话区域。
 *
 * 消息的渲染交给 assistant-ui 的原语：它负责把「消息 → 各类 part → 对应组件」
 * 这条路走通，我们只需要为文本、推理、工具调用这三种 part 各提供一个组件。
 *
 * 这里刻意没有提供消息操作（复制、重新生成、编辑、分支）：
 * EasyCode 的模型是「事件日志不可改写」，重新生成意味着改写历史，
 * 与事件溯源的前提冲突。少几个按钮比给出语义不成立的按钮要好。
 */

/* -------------------------------------------------------------------------- */
/* part 组件                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 助手正文。
 *
 * 用 Markdown 渲染而不是纯文本：模型给出的回答里代码块与列表占比很高，
 * 纯文本会把它们挤成一大段，读起来非常吃力。
 *
 * `smooth` 关掉：它会让文字以「打字机」效果延迟出现，
 * 而我们已经有了真实的流式增量，再加一层动画只会让光标位置与真实进度对不上。
 */
const MarkdownText = () => <MarkdownTextPrimitive className="markdown" smooth={false} />

/** 用户消息的正文。用户输入就是纯文本，套 Markdown 会把 # 之类的字符吃掉。 */
const PlainText = ({ text }: TextMessagePartProps) => <div className="plain-text">{text}</div>

/** 推理过程。默认折叠：它通常比结论长得多，展开是少数情况。 */
const ReasoningBlock = ({ text }: ReasoningMessagePartProps) => {
  const [open, setOpen] = useState(false)

  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? "▾" : "▸"} 思考过程
      </button>
      {open && <pre className="reasoning-body">{text}</pre>}
    </div>
  )
}

/**
 * 工具调用卡片。
 *
 * 三种状态一眼可辨：执行中（灰点）、成功（绿点）、失败（红点）。
 * 默认折叠，因为一次任务里工具调用可能很多，全部展开会把对话刷没。
 */
const ToolCard = ({ toolName, args, result, isError }: ToolCallMessagePartProps) => {
  const [open, setOpen] = useState(false)

  const view = result as ToolResultView | undefined
  const state = view === undefined ? "running" : isError === true || !view.ok ? "error" : "success"

  return (
    <div className={`tool-card tool-${state}`}>
      <button type="button" className="tool-header" onClick={() => setOpen((value) => !value)}>
        <span className={`tool-dot tool-dot-${state}`} aria-hidden />
        <span className="tool-name">{toolName}</span>
        <span className="tool-summary">{summarizeToolInput(args)}</span>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="tool-body">
          {view === undefined ? (
            <div className="tool-pending">执行中…</div>
          ) : (
            <pre className="tool-output">{view.text}</pre>
          )}
          {view !== undefined && view.outputPaths.length > 0 && (
            <div className="tool-paths">完整输出已落盘：{view.outputPaths.join("、")}</div>
          )}
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 消息组件                                                                    */
/* -------------------------------------------------------------------------- */

const UserMessage = () => (
  <MessagePrimitive.Root className="message message-user">
    <MessagePrimitive.Parts components={{ Text: PlainText }} />
  </MessagePrimitive.Root>
)

const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message-assistant">
    <MessagePrimitive.Parts
      components={{
        Text: MarkdownText,
        Reasoning: ReasoningBlock,
        tools: { Fallback: ToolCard },
      }}
    />
  </MessagePrimitive.Root>
)

/* -------------------------------------------------------------------------- */
/* 审批卡片                                                                    */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* 用量展示                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * token 用量。
 *
 * 分两个数字，因为它们回答的是两个不同的问题：
 * - 上下文占用：最后一次调用实际吃掉了多少 token，决定「还能聊多久」
 * - 会话累计：整个会话一共花了多少，用于事后回顾
 */
const UsageBar = ({ total, contextUsage, contextWindow }: { total: Usage; contextUsage?: Usage; contextWindow?: number }) => {
  const used = contextUsage === undefined ? 0 : usageTotal(contextUsage)
  const ratio = contextWindow === undefined || contextWindow <= 0 ? undefined : Math.min(1, used / contextWindow)

  return (
    <div className="usage">
      {contextWindow === undefined ? (
        <span>当前上下文 {formatTokens(used)} token</span>
      ) : (
        <span>
          上下文 {formatTokens(used)} / {formatTokens(contextWindow)}
          {ratio === undefined ? "" : `（${Math.round(ratio * 100)}%）`}
        </span>
      )}
      <span className="usage-sep">·</span>
      <span>本会话累计 {formatTokens(usageTotal(total))} token</span>
      {ratio !== undefined && ratio > 0.8 && <span className="usage-warn">即将压缩历史</span>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 主体                                                                        */
/* -------------------------------------------------------------------------- */

/** 取最后一条助手消息的用量，作为「当前上下文占用」的近似值。 */
const useContextUsage = (messages: Message[]): Usage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === "assistant" && message.usage !== undefined) return message.usage
  }
  return undefined
}

export const Chat = ({ store }: { store: EasyCodeStore }) => {
  const contextUsage = useMemo(() => useContextUsage(store.messages), [store.messages])
  const session = store.currentSession

  if (store.currentSessionID === undefined) {
    return (
      <main className="chat chat-empty">
        <div className="empty-state">
          <h2>还没有打开的会话</h2>
          <p>在左侧选择一个会话，或者新建一个：新建时需要先指定工作目录。</p>
        </div>
      </main>
    )
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">{session?.title ?? "会话"}</div>
        <div className="chat-meta">
          <span title={session?.directory}>{session?.directory}</span>
          <span className="chat-meta-sep">·</span>
          <span>{session?.model}</span>
        </div>
        {!store.connected && <div className="banner banner-warn">与服务端的连接已断开，正在自动重连…</div>}
      </header>

      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport">
          <ThreadPrimitive.Empty>
            <div className="empty-state">
              <h2>开始吧</h2>
              <p>描述你要完成的编码任务。当前工作目录是 {session?.directory}。</p>
            </div>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </ThreadPrimitive.Viewport>

        <div className="chat-footer">
          {store.pendingPermissions.map((request) => (
            <PermissionCard
              key={request.id}
              request={request}
              onReply={(requestID, reply) => void store.replyPermission(requestID, reply)}
            />
          ))}

          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              className="composer-input"
              placeholder="描述你要完成的编码任务…（Enter 发送，Shift+Enter 换行）"
              rows={3}
            />
            <div className="composer-actions">
              {store.running ? (
                <ComposerPrimitive.Cancel className="btn btn-danger">停止</ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send className="btn btn-primary">发送</ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>

          <UsageBar
            total={session?.usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }}
            contextUsage={contextUsage}
            contextWindow={store.contextWindow}
          />
        </div>
      </ThreadPrimitive.Root>
    </main>
  )
}
