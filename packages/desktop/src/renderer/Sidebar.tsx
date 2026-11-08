import type { Session, Workspace } from "@easycode/schema"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { toDisplayPath } from "./bridge"
import type { EasyCodeStore } from "./store"
import { isDefaultWorkspace, type WorkspaceState } from "./workspace"

type ContextMenu =
  | { kind: "session"; sessionID: string; x: number; y: number }
  | { kind: "workspace"; workspaceID: string; x: number; y: number }

export const Sidebar = ({ store, workspace }: { store: EasyCodeStore; workspace: WorkspaceState }) => {
  const hasWorkspace = workspace.activeWorkspace !== undefined
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [initializedWorkspaceIDs, setInitializedWorkspaceIDs] = useState<Set<string>>(() => new Set())
  const [menu, setMenu] = useState<ContextMenu | undefined>()
  const [renamingWorkspaceID, setRenamingWorkspaceID] = useState<string | undefined>()
  const [renameDraft, setRenameDraft] = useState("")
  const [renamingSessionID, setRenamingSessionID] = useState<string | undefined>()
  const [sessionRenameDraft, setSessionRenameDraft] = useState("")
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedSessionIDs, setSelectedSessionIDs] = useState<Set<string>>(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const renameTarget = useRef<string | undefined>(undefined)
  const sessionRenameTarget = useRef<string | undefined>(undefined)
  const knownWorkspaceIDs = useRef<Set<string> | undefined>(undefined)
  const menuSession =
    menu?.kind === "session" ? store.allSessions.find((session) => session.id === menu.sessionID) : undefined
  const menuWorkspace =
    menu?.kind === "workspace" ? workspace.workspaces.find((item) => item.id === menu.workspaceID) : undefined
  const sessionsByDirectory = useMemo(() => groupSessions(store.allSessions), [store.allSessions])
  const activeSessions = useMemo(
    () =>
      workspace.activeWorkspace === undefined
        ? []
        : (sessionsByDirectory.get(workspace.activeWorkspace.directory) ?? []),
    [sessionsByDirectory, workspace.activeWorkspace],
  )

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
    const ids = new Set(workspace.workspaces.map((item) => item.id))
    const previous = knownWorkspaceIDs.current
    knownWorkspaceIDs.current = ids
    setCollapsed((current) => {
      const next = new Set<string>()
      for (const id of ids) {
        if (previous === undefined || !previous.has(id) || current.has(id)) next.add(id)
      }
      return next
    })
    setInitializedWorkspaceIDs(new Set(ids))
  }, [workspace.workspaces])

  useEffect(() => {
    const directory = store.currentSession?.directory
    if (directory === undefined) return
    const workspaceID = workspace.workspaces.find((item) => item.directory === directory)?.id
    if (workspaceID === undefined) return
    setCollapsed((current) => {
      if (!current.has(workspaceID)) return current
      const next = new Set(current)
      next.delete(workspaceID)
      return next
    })
  }, [store.currentSession?.directory, workspace.workspaces])

  useEffect(() => {
    setSelectionMode(false)
    setSelectedSessionIDs(new Set())
  }, [workspace.activeWorkspace?.id])

  useEffect(() => {
    if (!selectionMode) return
    const available = new Set(activeSessions.map((session) => session.id))
    setSelectedSessionIDs((current) => {
      const next = new Set([...current].filter((id) => available.has(id)))
      return next.size === current.size ? current : next
    })
  }, [activeSessions, selectionMode])

  const toggleWorkspace = (workspaceID: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(workspaceID)) next.delete(workspaceID)
      else next.add(workspaceID)
      return next
    })
  }

  const selectWorkspace = (workspaceID: string): void => {
    workspace.selectWorkspace(workspaceID)
    if (workspaceID !== workspace.activeWorkspace?.id) {
      setSelectionMode(false)
      setSelectedSessionIDs(new Set())
    }
    setCollapsed((current) => {
      if (!current.has(workspaceID)) return current
      const next = new Set(current)
      next.delete(workspaceID)
      return next
    })
  }

  const selectSession = (session: Session, workspaceID: string): void => {
    if (workspace.activeWorkspace?.id !== workspaceID) selectWorkspace(workspaceID)
    store.selectSession(session.id)
  }

  const deleteSession = (sessionID: string): void => {
    setMenu(undefined)
    if (!window.confirm("确定永久删除这个会话及其全部聊天记录吗？")) return
    void store.deleteSession(sessionID)
  }

  const deleteWorkspace = async (item: Workspace): Promise<void> => {
    setMenu(undefined)
    if (isDefaultWorkspace(item)) return
    const sessionCount = store.allSessions.filter((session) => session.directory === item.directory).length
    const records = sessionCount === 0 ? "" : `及其 ${sessionCount} 个会话记录`
    const confirmed = window.confirm(
      `确定从 EasyCode 删除“${item.name}”工作区${records}吗？\n\n本地目录和文件不会被删除。`,
    )
    if (!confirmed) return
    const result = await workspace.deleteWorkspace(item.id)
    if (result === undefined) return
    if (workspace.activeWorkspace?.id === item.id) {
      const defaultWorkspace = workspace.workspaces.find(isDefaultWorkspace)
      if (defaultWorkspace !== undefined) {
        setCollapsed((current) => {
          const next = new Set(current)
          next.add(defaultWorkspace.id)
          return next
        })
      }
      store.startNewSession()
    }
    store.refreshSessions()
  }

  const startRename = (workspaceID: string, name: string): void => {
    setMenu(undefined)
    renameTarget.current = workspaceID
    setRenamingWorkspaceID(workspaceID)
    setRenameDraft(name)
  }

  const finishRename = async (): Promise<void> => {
    const workspaceID = renameTarget.current
    const name = renameDraft.trim()
    renameTarget.current = undefined
    setRenamingWorkspaceID(undefined)
    if (workspaceID === undefined || name.length === 0) return
    const current = workspace.workspaces.find((item) => item.id === workspaceID)
    if (current?.name === name) return
    await workspace.rename(workspaceID, name)
  }

  const startSessionRename = (session: Session): void => {
    setMenu(undefined)
    sessionRenameTarget.current = session.id
    setRenamingSessionID(session.id)
    setSessionRenameDraft(session.title)
  }

  const finishSessionRename = async (): Promise<void> => {
    const sessionID = sessionRenameTarget.current
    const title = sessionRenameDraft.trim()
    sessionRenameTarget.current = undefined
    setRenamingSessionID(undefined)
    if (sessionID === undefined || title.length === 0) return
    const current = store.allSessions.find((session) => session.id === sessionID)
    if (current?.title === title) return
    await store.renameSession(sessionID, title)
  }

  const exitSelection = (): void => {
    setSelectionMode(false)
    setSelectedSessionIDs(new Set())
  }

  const toggleSelectedSession = (sessionID: string): void => {
    setSelectedSessionIDs((current) => {
      const next = new Set(current)
      if (next.has(sessionID)) next.delete(sessionID)
      else next.add(sessionID)
      return next
    })
  }

  const toggleSelectAll = (): void => {
    setSelectedSessionIDs((current) =>
      current.size === activeSessions.length ? new Set() : new Set(activeSessions.map((session) => session.id)),
    )
  }

  const deleteSelectedSessions = async (): Promise<void> => {
    if (selectedSessionIDs.size === 0 || bulkDeleting) return
    if (
      !window.confirm(
        `确定永久删除选中的 ${selectedSessionIDs.size} 个会话及其全部聊天记录吗？\n\n正在运行的会话会先被中断。`,
      )
    ) {
      return
    }

    setBulkDeleting(true)
    try {
      const result = await store.deleteSessions([...selectedSessionIDs])
      if (result.failed.length === 0) exitSelection()
      else setSelectedSessionIDs(new Set(result.failed.map((item) => item.sessionID)))
    } catch {
      // Store 已经展示具体错误，保留当前选择便于重试。
    } finally {
      setBulkDeleting(false)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-name">EasyCode</span>
      </div>

      <div className="sidebar-top">
        {selectionMode ? (
          <div className="session-selection-toolbar">
            <div className="session-selection-summary">
              <span>已选 {selectedSessionIDs.size} 个会话</span>
              <button
                type="button"
                className="workspace-add-button"
                onClick={exitSelection}
                aria-label="退出多选"
                title="退出多选"
              >
                <X size={15} strokeWidth={1.8} />
              </button>
            </div>
            <div className="session-selection-actions">
              <button type="button" className="selection-action-button" onClick={toggleSelectAll}>
                {selectedSessionIDs.size === activeSessions.length ? "取消全选" : "全选"}
              </button>
              <button
                type="button"
                className="selection-action-button selection-action-danger"
                onClick={() => void deleteSelectedSessions()}
                disabled={selectedSessionIDs.size === 0 || bulkDeleting}
              >
                <Trash2 size={14} strokeWidth={1.8} />
                {bulkDeleting ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="new-session-button"
            onClick={store.startNewSession}
            disabled={!hasWorkspace}
            title={hasWorkspace ? "在当前工作区中新建会话" : "请先添加工作区"}
          >
            <Plus size={16} strokeWidth={2} />
            <span>新会话</span>
          </button>
        )}
      </div>

      <div className="workspace-section-header">
        <span>工作区</span>
        <div className="workspace-section-actions">
          <button
            type="button"
            className={`workspace-add-button${selectionMode ? " workspace-add-button-active" : ""}`}
            onClick={() => {
              if (selectionMode) exitSelection()
              else {
                setSelectionMode(true)
                setSelectedSessionIDs(new Set())
                if (workspace.activeWorkspace !== undefined) {
                  setCollapsed((current) => {
                    const next = new Set(current)
                    next.delete(workspace.activeWorkspace!.id)
                    return next
                  })
                }
              }
            }}
            disabled={activeSessions.length === 0}
            title={selectionMode ? "退出多选" : "多选当前工作区会话"}
            aria-label={selectionMode ? "退出多选" : "多选当前工作区会话"}
          >
            <ListChecks size={16} strokeWidth={1.8} />
          </button>
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
      </div>

      <nav className="workspace-list" aria-label="工作区与会话">
        {workspace.loading && <div className="sidebar-empty">正在加载工作区…</div>}

        {!workspace.loading && workspace.workspaces.length === 0 && (
          <div className="sidebar-empty">点击右上角的文件夹按钮添加工作区。</div>
        )}

        {workspace.workspaces.map((item) => {
          const sessions = sessionsByDirectory.get(item.directory) ?? []
          const isCollapsed = !initializedWorkspaceIDs.has(item.id) || collapsed.has(item.id)
          const isActive = item.id === workspace.activeWorkspace?.id
          return (
            <section key={item.id} className={`workspace-group${isActive ? " workspace-group-active" : ""}`}>
              <div
                className="workspace-row"
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    kind: "workspace",
                    workspaceID: item.id,
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 120)),
                  })
                }}
              >
                <button
                  type="button"
                  className="workspace-toggle"
                  onClick={() => toggleWorkspace(item.id)}
                  aria-label={isCollapsed ? "展开工作区" : "收起工作区"}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
                <div
                  className="workspace-select"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (renamingWorkspaceID !== item.id) selectWorkspace(item.id)
                  }}
                  onKeyDown={(event) => {
                    if (renamingWorkspaceID === item.id) return
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      selectWorkspace(item.id)
                    }
                  }}
                  title={item.directory}
                >
                  <Folder size={15} strokeWidth={1.8} className="workspace-icon" />
                  {renamingWorkspaceID === item.id ? (
                    <input
                      className="workspace-rename-input"
                      value={renameDraft}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void finishRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          void finishRename()
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          renameTarget.current = undefined
                          setRenameDraft(item.name)
                          setRenamingWorkspaceID(undefined)
                        }
                      }}
                    />
                  ) : (
                    <span className="workspace-name">{item.name}</span>
                  )}
                  <span className="workspace-path">({toDisplayPath(item.directory)})</span>
                </div>
              </div>

              {!isCollapsed && (
                <div className="workspace-sessions">
                  {sessions.length === 0 && <div className="session-empty">这个工作区还没有会话。</div>}
                  {sessions.map((session) => {
                    const className = `session-item${session.id === store.currentSessionID ? " session-item-active" : ""}`
                    const selectable = selectionMode && isActive
                    const selected = selectedSessionIDs.has(session.id)
                    if (renamingSessionID === session.id) {
                      return (
                        <div key={session.id} className={`${className} session-item-editing`}>
                          <input
                            className="session-rename-input"
                            value={sessionRenameDraft}
                            autoFocus
                            onChange={(event) => setSessionRenameDraft(event.target.value)}
                            onBlur={() => void finishSessionRename()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault()
                                void finishSessionRename()
                              } else if (event.key === "Escape") {
                                event.preventDefault()
                                sessionRenameTarget.current = undefined
                                setSessionRenameDraft(session.title)
                                setRenamingSessionID(undefined)
                              }
                            }}
                          />
                        </div>
                      )
                    }
                    if (selectable) {
                      return (
                        <label
                          key={session.id}
                          className={`${className} session-item-selection${selected ? " session-item-selected" : ""}`}
                          title={session.title}
                        >
                          <input
                            className="session-selection-checkbox"
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleSelectedSession(session.id)}
                          />
                          <span className="session-title">{session.title}</span>
                          {session.pinnedAt !== undefined && (
                            <Pin size={13} strokeWidth={1.8} className="session-pin" aria-label="已置顶" />
                          )}
                        </label>
                      )
                    }
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={className}
                        onClick={() => selectSession(session, item.id)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setMenu({
                            kind: "session",
                            sessionID: session.id,
                            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)),
                            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)),
                          })
                        }}
                        title={session.title}
                      >
                        <span className="session-title">{session.title}</span>
                        {session.pinnedAt !== undefined && (
                          <Pin size={13} strokeWidth={1.8} className="session-pin" aria-label="已置顶" />
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
      </nav>

      {menu?.kind === "session" && menuSession !== undefined && (
        <div
          ref={menuRef}
          className="session-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => startSessionRename(menuSession)}>
            <Pencil size={14} />
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(undefined)
              void store.pinSession(menuSession.id, menuSession.pinnedAt === undefined)
            }}
          >
            {menuSession.pinnedAt === undefined ? <Pin size={14} /> : <PinOff size={14} />}
            {menuSession.pinnedAt === undefined ? "置顶" : "取消置顶"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-context-danger"
            onClick={() => deleteSession(menuSession.id)}
          >
            <Trash2 size={14} />
            删除
          </button>
        </div>
      )}

      {menu?.kind === "workspace" && menuWorkspace !== undefined && (
        <div
          ref={menuRef}
          className="session-context-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => startRename(menuWorkspace.id, menuWorkspace.name)}>
            <Pencil size={14} />
            重命名
          </button>
          {!isDefaultWorkspace(menuWorkspace) && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(undefined)
                  void workspace.pin(menuWorkspace.id, menuWorkspace.pinnedAt === undefined)
                }}
              >
                {menuWorkspace.pinnedAt === undefined ? <Pin size={14} /> : <PinOff size={14} />}
                {menuWorkspace.pinnedAt === undefined ? "置顶" : "取消置顶"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-context-danger"
                onClick={() => void deleteWorkspace(menuWorkspace)}
              >
                <Trash2 size={14} />
                删除
              </button>
            </>
          )}
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
