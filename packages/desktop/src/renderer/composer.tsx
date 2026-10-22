import { ArrowUp, Plus, Square } from "lucide-react"
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"

const ICON_STROKE = 1.8
const MAX_INPUT_HEIGHT = 180

export const Composer = ({
  running,
  onSend,
  onStop,
}: {
  running: boolean
  onSend: (text: string) => Promise<void>
  onStop: () => Promise<void>
}) => {
  const [draft, setDraft] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [draft])

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || submitting) return

    setDraft("")
    setSubmitting(true)
    try {
      await onSend(text)
    } finally {
      setSubmitting(false)
      input.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    void submit(event)
  }

  const canSend = draft.trim().length > 0 && !submitting

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <textarea
        ref={input}
        className="composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="发消息…（Enter 发送，Shift+Enter 换行）"
        rows={1}
        aria-label="消息输入框"
        disabled={submitting}
      />

      <div className="composer-toolbar">
        <button type="button" className="composer-plus" disabled title="附件功能暂未支持">
          <Plus size={18} strokeWidth={ICON_STROKE} />
        </button>

        <div className="composer-actions">
          {running && (
            <button
              type="button"
              className="composer-send composer-stop"
              title="停止生成"
              aria-label="停止生成"
              onClick={() => void onStop()}
            >
              <Square size={12} strokeWidth={0} fill="currentColor" />
            </button>
          )}
          <button
            type="submit"
            className="composer-send"
            title={running ? "发送插话" : "发送"}
            aria-label={running ? "发送插话" : "发送消息"}
            disabled={!canSend}
          >
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </form>
  )
}
