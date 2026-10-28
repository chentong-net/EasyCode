import type { Session } from "@easycode/schema"
import { ChevronDown, ChevronRight, Folder, FolderPlus, Pin, PinOff, Plus, Trash2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { toDisplayPath } from "./bridge"
import type { EasyCodeStore } from "./store"
import type { WorkspaceState } from "./workspace"

interface SessionMenu {
  sessionID: string
  x: number
  y: number
}

export const Sidebar = ({ store, workspace }: { store: EasyCodeStore; workspace: WorkspaceState }) => {
  const hasWorkspace = workspace.activeWorkspace !== undefined
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<SessionMenu | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)
  const menuSession = menu === undefined ? undefined : store.allSessions.find((session) => session.id === menu.sessionID)
  const sessionsByDirectory = useMemo(() => groupSessions(store.allSessions), [store.allSessions])

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

  useEffect(() => {
    const activeID = workspace.activeWorkspace?.id
    if (activeID === undefined) return
    setCollapsed((previous) => {
      if (!previous.has(activeID)) return previous
      const next = new Set(previous)
      next.delete(activeID)
      return next
    })
  }, [workspace.activeWorkspace?.id])

  const toggleWorkspace = (workspaceID: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(workspaceID)) next.delete(workspaceID)
      else next.add(workspaceID)
      return next
    })
  }

  const selectSession = (session: Session, workspaceID: string): void => {
    if (workspace.activeWorkspace?.id !== workspaceID) workspace.selectWorkspace(workspaceID)
    store.selectSession(session.id)
  }

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
          className="new-session-button"
          onClick={() => void store.createSession()}
          disabled={!hasWorkspace}
          title={hasWorkspace ? "在当前工作区中新建会话" : "请先添加工作区"}
        >
          <Plus size={16} strokeWidth={2} />
          <span>新会话</span>
        </button>
      </div>

      <div className="workspace-section-header">
        <span>工作区</span>
        <button
          type="button"
          className="workspace-add-button"
          onClick={() => void workspace.select()}
          disabled={workspace.selecting}
          title="添加工作区目录"
          aria-label="添加工作区目录"
        >
          <FolderPlus size={16} strokeWidth={1.8} />
        </button>
      </div>

      <nav className="workspace-list" aria-label="工作区与会话">
        {workspace.loading && <div className="sidebar-empty">正在加载工作区…</div>}

        {!workspace.loading && workspace.workspaces.length === 0 && (
          <div className="sidebar-empty">点击右上角的文件夹按钮添加工作区。</div>
        )}

        {workspace.workspaces.map((item) => {
          const sessions = sessionsByDirectory.get(item.directory) ?? []
          const isCollapsed = collapsed.has(item.id)
          const isActive = item.id === workspace.activeWorkspace?.id
          return (
            <section key={item.id} className={`workspace-group${isActive ? " workspace-group-active" : ""}`}>
              <div className="workspace-row">
                <button
                  type="button"
                  className="workspace-toggle"
                  onClick={() => toggleWorkspace(item.id)}
                  aria-label={isCollapsed ? "展开工作区" : "收起工作区"}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <button
                  type="button"
                  className="workspace-select"
                  onClick={() => workspace.selectWorkspace(item.id)}
                  title={item.directory}
                >
                  <Folder size={15} strokeWidth={1.8} className="workspace-icon" />
                  <span className="workspace-name">{item.name}</span>
                  <span className="workspace-path">({toDisplayPath(item.directory)})</span>
                </button>
              </div>

              {!isCollapsed && (
                <div className="workspace-sessions">
                  {sessions.length === 0 && <div className="session-empty">这个工作区还没有会话。</div>}
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`session-item${session.id === store.currentSessionID ? " session-item-active" : ""}`}
                      onClick={() => selectSession(session, item.id)}
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
                </div>
              )}
            </section>
          )
        })}
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

const groupSessions = (sessions: Session[]): Map<string, Session[]> => {
  const grouped = new Map<string, Session[]>()
  for (const session of sessions) {
    const existing = grouped.get(session.directory)
    if (existing) existing.push(session)
    else grouped.set(session.directory, [session])
  }
  return grouped
}
