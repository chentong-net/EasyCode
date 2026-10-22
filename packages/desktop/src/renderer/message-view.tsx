import type { Content, Message, Part } from "@easycode/schema"
import { Copy, Ellipsis } from "lucide-react"
import { useState, type ComponentProps } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { summarizeToolInput } from "./format"

const ICON_STROKE = 1.8
const REMARK_PLUGINS = [remarkGfm]

const MarkdownTable = (props: ComponentProps<"table">) => (
  <div className="markdown-table-scroll">
    <table {...props} />
  </div>
)

const MARKDOWN_COMPONENTS = { table: MarkdownTable }

const Markdown = ({ text }: { text: string }) => (
  <div className="markdown">
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {text}
    </ReactMarkdown>
  </div>
)

const ReasoningBlock = ({ text }: { text: string }) => {
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

type ToolPart = Extract<Part, { type: "tool" }>

const ToolCard = ({ part }: { part: ToolPart }) => {
  const [open, setOpen] = useState(false)
  const view = toToolView(part)
  const state = part.state.status === "pending" ? "running" : view.ok ? "success" : "error"

  return (
    <div className={`tool-card tool-${state}`}>
      <button type="button" className="tool-header" onClick={() => setOpen((value) => !value)}>
        <span className={`tool-dot tool-dot-${state}`} aria-hidden />
        <span className="tool-name">{part.name}</span>
        <span className="tool-summary">{summarizeToolInput(part.input)}</span>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="tool-body">
          {part.state.status === "pending" ? (
            <div className="tool-pending">执行中…</div>
          ) : (
            <pre className="tool-output">{view.text}</pre>
          )}
          {view.outputPaths.length > 0 && (
            <div className="tool-paths">完整输出已落盘：{view.outputPaths.join("、")}</div>
          )}
          {view.changedPaths.length > 0 && (
            <div className="tool-paths">修改文件：{view.changedPaths.join("、")}</div>
          )}
          {view.verification !== undefined && (
            <div className="tool-paths">
              验证{verificationLabel(view.verification.status)}：{view.verification.summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const toolStateView = (part: Exclude<ToolPart["state"], { status: "pending" }>) => ({
  ok: part.status === "success",
  text: contentText(part.content ?? []) || (part.status === "error" ? part.error : "（工具执行完成，没有输出）"),
  outputPaths: part.outputPaths ?? [],
  changedPaths: part.metadata?.changedPaths ?? [],
  verification: part.metadata?.verification,
})

const toToolView = (part: ToolPart) =>
  part.state.status === "pending"
    ? { ok: true, text: "", outputPaths: [], changedPaths: [], verification: undefined }
    : toolStateView(part.state)

const verificationLabel = (status: "passed" | "failed" | "unknown"): string => {
  if (status === "passed") return "通过"
  if (status === "failed") return "失败"
  return "结果未知"
}

const contentText = (content: Content[]): string =>
  content
    .map((part) => (part.type === "text" ? part.text : `[附件 ${part.name ?? part.mime}]`))
    .join("\n")

const Attachment = ({ part }: { part: Extract<Part, { type: "file" }> }) => (
  <div className="message-file">附件：{part.name ?? part.mime}</div>
)

const AssistantParts = ({ message }: { message: Extract<Message, { role: "assistant" }> }) => (
  <>
    {message.parts.map((part, index) => {
      switch (part.type) {
        case "text":
          return <Markdown key={`text-${index}`} text={part.text} />
        case "reasoning":
          return <ReasoningBlock key={`reasoning-${index}`} text={part.text} />
        case "tool":
          return <ToolCard key={part.callID} part={part} />
        case "file":
          return <Attachment key={`file-${index}`} part={part} />
      }
    })}
  </>
)

const UserParts = ({ message }: { message: Extract<Message, { role: "user" }> }) =>
  message.parts.map((part, index) => {
    if (part.type === "text") {
      return (
        <div key={`text-${index}`} className="plain-text">
          {part.text}
        </div>
      )
    }
    if (part.type === "file") return <Attachment key={`file-${index}`} part={part} />
    return null
  })

const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className="message-action"
      title={copied ? "已复制" : "复制这条回复"}
      data-copied={copied}
      aria-label={copied ? "已复制" : "复制这条回复"}
      onClick={() => void copy()}
    >
      <Copy size={14} strokeWidth={ICON_STROKE} />
    </button>
  )
}

const MessageActions = ({ text }: { text: string }) => (
  <div className="message-actions">
    <CopyButton text={text} />
    <button type="button" className="message-action" disabled title="更多操作暂未支持">
      <Ellipsis size={14} strokeWidth={ICON_STROKE} />
    </button>
  </div>
)

const messageText = (message: Message): string => {
  if (message.role === "assistant") {
    return [
      ...message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ...(message.error ? [`⚠️ ${message.error}`] : []),
    ].join("\n\n")
  }
  if (message.role === "user") {
    return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n")
  }
  return ""
}

export const MessageView = ({ message }: { message: Message }) => {
  if (message.role === "user") {
    return (
      <article className="message message-user" data-message-id={message.id}>
        <UserParts message={message} />
      </article>
    )
  }

  if (message.role !== "assistant") return null

  return (
    <article className="message message-assistant" data-message-id={message.id}>
      <AssistantParts message={message} />
      {message.error !== undefined && <div className="message-error">⚠️ {message.error}</div>}
      {message.completedAt === undefined && (
        <div className="message-running" aria-label="正在生成">
          <span />
        </div>
      )}
      <MessageActions text={messageText(message)} />
    </article>
  )
}
