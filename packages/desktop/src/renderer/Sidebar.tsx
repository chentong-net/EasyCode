import { Folder, Plus } from "lucide-react"

import type { EasyCodeStore } from "./store"
import type { WorkspaceState } from "./workspace"

/**
 * 侧边栏：工作目录、新建入口、会话列表。
 *
 * 列表只显示当前工作目录下的会话 —— 会话与目录是绑定的，把不同目录的会话混在
 * 一起会让人分不清「这次改动发生在哪个项目里」。目录本身由顶部的选择器决定，
 * 点一下就用系统弹窗换一个。
 *
 * 会话条目只显示标题，不带目录与时间：目录已经由顶部的选择器统一表达了，
 * 时间对「找到最近那个会话」的帮助也远不如标题本身。
 */
export const Sidebar = ({ store, workspace }: { store: EasyCodeStore; workspace: WorkspaceState }) => {
  const hasWorkspace = workspace.directory !== undefined

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button
          type="button"
          className="workspace-button"
          onClick={() => void workspace.select()}
          disabled={workspace.selecting}
          title={workspace.directory ?? "选择一个工作目录"}
        >
          <Folder size={15} strokeWidth={1.8} className="workspace-icon" />
          <span className="workspace-label">
            {workspace.selecting ? "加载中…" : (workspace.label ?? "选择工作目录")}
          </span>
        </button>

        <button
          type="button"
          className="new-session-button"
          onClick={() => void store.createSession()}
          disabled={!hasWorkspace}
          title={hasWorkspace ? "在当前工作目录下新建会话" : "请先选择工作目录"}
        >
          <Plus size={15} strokeWidth={2} />
          <span>新建会话</span>
        </button>
      </div>

      <nav className="session-list">
        {!hasWorkspace && <div className="session-empty">选择一个工作目录后，这里会列出它的会话。</div>}

        {hasWorkspace && store.loading && <div className="session-empty">正在加载…</div>}

        {hasWorkspace && !store.loading && store.sessions.length === 0 && (
          <div className="session-empty">这个目录下还没有会话。</div>
        )}

        {store.sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            className={`session-item${session.id === store.currentSessionID ? " session-item-active" : ""}`}
            onClick={() => store.selectSession(session.id)}
            title={session.title}
          >
            {session.title}
          </button>
        ))}
      </nav>
    </aside>
  )
}
