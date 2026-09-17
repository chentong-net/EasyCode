import { DEFAULT_WORKSPACE_DIRECTORY } from "@easycode/protocol"
import { useState } from "react"

import { formatRelativeTime } from "./format"
import type { EasyCodeStore } from "./store"

/**
 * 侧边栏：会话列表与新建入口。
 *
 * 会话与工作目录是绑定的，因此「新建」不是一步操作，而是两步：
 * 先指定目录，再创建对话。界面上刻意把这两件事分开表达 ——
 * 目录输入框只在新建时出现，创建后它就不再可改，
 * 避免用户误以为可以给已有会话换目录（那会让历史里的所有相对路径失效）。
 */
export const Sidebar = ({ store }: { store: EasyCodeStore }) => {
  const [creating, setCreating] = useState(false)
  const [directory, setDirectory] = useState(DEFAULT_WORKSPACE_DIRECTORY)

  const submit = async (): Promise<void> => {
    const target = directory.trim()
    if (target.length === 0) return
    await store.createSession(target)
    setCreating(false)
  }

  return (
    <aside className="sidebar">
      {/*
        品牌区同时是窗口拖拽区。macOS 用隐藏式标题栏，左上角被系统画了红绿灯按钮，
        因此这一块的内容需要在样式里让出位置（见 styles.css 中针对 darwin 的规则）。
      */}
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden>
          E
        </span>
        <span className="brand-name">EasyCode</span>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className={`btn btn-block${creating ? " btn-active" : ""}`}
          onClick={() => setCreating((value) => !value)}
        >
          {creating ? "取消新建" : "＋ 新建会话"}
        </button>
      </div>

      {creating && (
        <form
          className="new-session"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className="field-label" htmlFor="workspace-directory">
            工作目录
          </label>
          <input
            id="workspace-directory"
            className="field-input"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="~/easy_code"
            spellCheck={false}
          />
          <p className="field-hint">以 ~ 开头表示用户主目录。目录不存在时会自动创建。</p>
          <button type="submit" className="btn btn-primary btn-block">
            创建会话
          </button>
        </form>
      )}

      <nav className="session-list">
        {store.loading && <div className="session-empty">正在加载…</div>}

        {!store.loading && store.sessions.length === 0 && (
          <div className="session-empty">还没有会话。点击上面的「新建会话」开始。</div>
        )}

        {store.sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`session-item${session.id === store.currentSessionID ? " session-item-active" : ""}`}
            onClick={() => store.selectSession(session.id)}
            title={session.directory}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-sub">
              {formatRelativeTime(session.updatedAt)} · {session.directory}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  )
}
