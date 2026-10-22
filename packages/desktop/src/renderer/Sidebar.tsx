import { Folder, Pin, PinOff, Plus, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

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
  const [menu, setMenu] = useState<{ sessionID: string; x: number; y: number } | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)
  const menuSession = menu === undefined ? undefined : store.sessions.find((session) => session.id === menu.sessionID)

  useEffect(() => {
    if (!menu) return
    const closeOnOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setMenu(undefined)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setMenu(undefined)
    }
    const closeOnResize = (): void => setMenu(undefined)
    window.addEventListener("pointerdown", closeOnOutside)
    window.addEventListener("keydown", closeOnEscape)
    window.addEventListener("resize", closeOnResize)
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside)
      window.removeEventListener("keydown", closeOnEscape)
      window.removeEventListener("resize", closeOnResize)
    }
  }, [menu])

  const deleteSession = (sessionID: string): void => {
    setMenu(undefined)
    if (!window.confirm("确定永久删除这个会话及其全部聊天记录吗？")) return
    void store.deleteSession(sessionID)
  }

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
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({
                sessionID: session.id,
                x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
                y: Math.max(8, Math.min(event.clientY, window.innerHeight - 100)),
              })
            }}
            title={session.title}
          >
            <span className="session-title">{session.title}</span>
            {session.pinnedAt !== undefined && (
              <Pin size={13} strokeWidth={1.8} className="session-pin" aria-label="已置顶" />
            )}
          </button>
        ))}
      </nav>

      {menu !== undefined && menuSession !== undefined && (
        <div
          ref={menuRef}
          className="session-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(undefined)
              void store.pinSession(menuSession.id, menuSession.pinnedAt === undefined)
            }}
          >
            {menuSession.pinnedAt === undefined ? <Pin size={14} /> : <PinOff size={14} />}
            {menuSession.pinnedAt === undefined ? "置顶会话" : "取消置顶"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-context-danger"
            onClick={() => deleteSession(menuSession.id)}
          >
            <Trash2 size={14} />
            删除会话
          </button>
        </div>
      )}
    </aside>
  )
}
