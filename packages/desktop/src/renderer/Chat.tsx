import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ReasoningMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react"
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown"
import type { Message, PermissionRequest, Usage } from "@easycode/schema"
import { ArrowUp, Copy, Ellipsis, Plus, RefreshCw, Square } from "lucide-react"
import { useMemo, useState, type ComponentProps } from "react"
import remarkGfm from "remark-gfm"

import { formatTokens, summarizeToolInput, usageTotal } from "./format"
import type { EasyCodeStore } from "./store"
import type { ToolResultView } from "./thread-message"
import type { WorkspaceState } from "./workspace"

/**
 * 对话区域。
 *
 * 三种状态在同一个组件里分派：没选工作目录、选了但还没有会话、正在用某个会话。
 * 前两种都需要用户先做一个动作（选目录 / 新建会话），因此不该把输入框也显示出来——
 * 一个点了没反应的输入框比没有输入框更让人困惑。
 *
 * 消息渲染交给 assistant-ui 的原语：它负责把「消息 → 各类 part → 对应组件」
 * 这条路走通，我们只需要为文本、推理、工具调用三种 part 各提供一个组件。
 */

/* -------------------------------------------------------------------------- */
/* 图标常量                                                                    */
/* -------------------------------------------------------------------------- */

/** 统一图标的描边粗细。默认值偏粗，在正文旁边显得吵。 */
const ICON_STROKE = 1.8

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
const MarkdownTable = (props: ComponentProps<"table">) => (
  <div className="markdown-table-scroll">
    <table {...props} />
  </div>
)

const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_COMPONENTS = { table: MarkdownTable }

const MarkdownText = () => (
  <MarkdownTextPrimitive
    className="markdown"
    smooth={false}
    remarkPlugins={MARKDOWN_REMARK_PLUGINS}
    components={MARKDOWN_COMPONENTS}
  />
)

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
 * 三种状态一眼可辨：执行中（蓝点，带呼吸）、成功（绿点）、失败（红点）。
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
          {view !== undefined && view.changedPaths.length > 0 && (
            <div className="tool-paths">修改文件：{view.changedPaths.join("、")}</div>
          )}
          {view?.verification !== undefined && (
            <div className="tool-paths">
              验证{view.verification.status === "passed" ? "通过" : "失败"}：{view.verification.summary}
            </div>
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

/**
 * 助手消息。
 *
 * 正文不加气泡：模型的长回复如果套在一个框里，读起来就像在看聊天记录而不是看文档。
 *
 * 下方三个操作里只有「复制」是可用的：
 * - 重新生成会改写已有结果，而 EasyCode 的历史是只能追加的事件日志，
 *   没有对应的语义，因此交给 assistant-ui 自动置灰（我们没有注册 reload 回调）
 * - 更多操作（导出、反馈等）同样没有实现，直接置灰，而不是留一个点了没反应的按钮
 */
const AssistantMessage = () => (
  <MessagePrimitive.Root className="message message-assistant">
    <MessagePrimitive.Parts
      components={{
        Text: MarkdownText,
        Reasoning: ReasoningBlock,
        tools: { Fallback: ToolCard },
      }}
    />

    <ActionBarPrimitive.Root className="message-actions">
      <ActionBarPrimitive.Copy className="message-action" title="复制这条回复" copiedDuration={1500}>
        <Copy size={14} strokeWidth={ICON_STROKE} />
      </ActionBarPrimitive.Copy>

      <ActionBarPrimitive.Reload className="message-action" title="重新生成（暂不支持：历史只能追加，不能改写）">
        <RefreshCw size={14} strokeWidth={ICON_STROKE} />
      </ActionBarPrimitive.Reload>

      <button type="button" className="message-action" disabled title="更多操作暂未支持">
        <Ellipsis size={14} strokeWidth={ICON_STROKE} />
      </button>
    </ActionBarPrimitive.Root>
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
/* 输入框                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 输入框。
 *
 * 空态下它紧跟在标题下面居中，有对话后固定贴底——同一个组件，只是外层容器
 * 的排布不同，这样输入内容不会因为在两种状态间移动而被清空。
 */
const Composer = ({ running }: { running: boolean }) => (
  <ComposerPrimitive.Root className="composer">
    <ComposerPrimitive.Input className="composer-input" placeholder="发消息…" rows={1} />

    <div className="composer-toolbar">
      {/*
        附件入口按原型保留，但功能还没做。置灰而不是隐藏：
        隐藏会让位置每次都在变，置灰至少说明「这里以后会有东西」。
      */}
      <button type="button" className="composer-plus" disabled title="附件功能暂未支持">
        <Plus size={18} strokeWidth={ICON_STROKE} />
      </button>

      {running ? (
        <ComposerPrimitive.Cancel className="composer-send" title="停止生成">
          <Square size={12} strokeWidth={0} fill="currentColor" />
        </ComposerPrimitive.Cancel>
      ) : (
        <ComposerPrimitive.Send className="composer-send" title="发送">
          <ArrowUp size={17} strokeWidth={2.4} />
        </ComposerPrimitive.Send>
      )}
    </div>
  </ComposerPrimitive.Root>
)

/* -------------------------------------------------------------------------- */
/* 底部状态栏                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 上下文占用的环形指示。
 *
 * 用环而不是进度条：这个数字平时不需要精确阅读，环的形状能在余光里
 * 传达「用了多少」，接近上限时变色就足够提醒了。
 */
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

/**
 * 用量视图。
 *
 * 单独抽成纯函数是为了让三个数字的「有没有值」在类型上就是一致的：
 * 只要 ratio 有值，used / quota / size 必然都有值，展示代码里不需要再做判断和断言。
 */
interface UsageView {
  /** 上下文窗口大小 */
  size: number | undefined
  /** 可用额度 = 窗口 − 单轮输出预留 */
  quota: number | undefined
  /** 上一次调用实际占用的 token */
  used: number | undefined
  /** 占用比例。undefined 表示还无法测量（没有对话，或还没拿到模型信息） */
  ratio: number | undefined
}

const buildUsageView = (size: number | undefined, reserve: number | undefined, usage: Usage | undefined): UsageView => {
  const quota = size !== undefined && reserve !== undefined && reserve < size ? size - reserve : undefined
  const used = usage === undefined ? undefined : usageTotal(usage)
  const ratio = used !== undefined && quota !== undefined && quota > 0 ? Math.min(1, used / quota) : undefined
  return { size, quota, used, ratio }
}

/**
 * 底部状态栏。
 *
 * 两个数字回答两个不同的问题：
 * - 上下文占用：这一次调用实际吃掉了多少，决定「还能聊多久」
 * - 额度：窗口减去单轮输出预留之后，真正能用来放历史的上限
 *
 * 原型里还有一个手动「压缩」按钮，这里刻意没有做：压缩在 EasyCode 里是
 * 自动触发的（接近额度时先压缩再重试），把它做成按钮会让用户以为需要自己盯着。
 */
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
      ? "自动压缩已就绪"
      : `自动压缩已就绪：窗口 ${windowLabel}，发第一条消息后这里显示占用`

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

export const Chat = ({ store, workspace }: { store: EasyCodeStore; workspace: WorkspaceState }) => {
  const contextUsage = useMemo(() => useContextUsage(store.messages), [store.messages])
  const hasConversation = store.messages.length > 0

  // 还没选工作目录：没有目录就没有「能在哪里动手」的边界，先让用户选一个
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

  // 目录有了但还没有会话：输入框不能显示，否则用户会以为可以直接提问
  if (store.currentSessionID === undefined) {
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
      <ThreadPrimitive.Root className={hasConversation ? "thread" : "thread thread-empty"}>
        <ThreadPrimitive.Viewport className="thread-viewport">
          <ThreadPrimitive.Empty>
            <h1 className="hero-title">今天想让我做点什么？</h1>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>

        <div className="composer-area">
          {store.pendingPermissions.map((request) => (
            <PermissionCard
              key={request.id}
              request={request}
              onReply={(requestID, reply) => void store.replyPermission(requestID, reply)}
            />
          ))}

          <Composer running={store.running} />
        </div>
      </ThreadPrimitive.Root>

      <StatusBar store={store} contextUsage={contextUsage} />
    </main>
  )
}
