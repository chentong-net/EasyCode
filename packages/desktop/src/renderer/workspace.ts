import type { EasyCodeClient } from "@easycode/client"
import { DEFAULT_WORKSPACE_DIRECTORY } from "@easycode/protocol"
import type { Workspace } from "@easycode/schema"
import { useCallback, useEffect, useMemo, useState } from "react"

import { selectDirectory, toDisplayPath } from "./bridge"
import { describeError } from "./format"

export interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspace: Workspace | undefined
  /** 当前工作区目录，供会话列表过滤和新建会话使用。 */
  directory: string | undefined
  /** 展示用路径，例如 ~/easycode。 */
  label: string | undefined
  loading: boolean
  selecting: boolean
  error: string | undefined
  selectWorkspace(workspaceID: string): void
  /** 选择目录并添加工作区；重复目录会直接选中已有项。 */
  select(): Promise<void>
  rename(workspaceID: string, name: string): Promise<Workspace | undefined>
  pin(workspaceID: string, pinned: boolean): Promise<Workspace | undefined>
  clearError(): void
}

export const useWorkspaces = (client: EasyCodeClient): WorkspaceState => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceID, setActiveWorkspaceID] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const list = await client.workspaces.list(controller.signal)
        if (controller.signal.aborted) return
        setWorkspaces(sortWorkspaces(list))
        const defaultWorkspace = list.find(isDefaultWorkspace)
        setActiveWorkspaceID(defaultWorkspace?.id ?? list[0]?.id)
      } catch (cause) {
        if (!controller.signal.aborted) setError(describeError(cause))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [client])

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceID),
    [activeWorkspaceID, workspaces],
  )

  const selectWorkspace = useCallback((workspaceID: string) => {
    setError(undefined)
    setActiveWorkspaceID(workspaceID)
  }, [])

  const select = useCallback(async () => {
    setSelecting(true)
    setError(undefined)
    try {
      const picked = await selectDirectory(activeWorkspace?.directory ?? DEFAULT_WORKSPACE_DIRECTORY)
      if (picked === undefined) return
      const workspace = await client.workspaces.add({ directory: picked })
      setWorkspaces((previous) =>
        sortWorkspaces(
          previous.some((item) => item.id === workspace.id)
            ? previous.map((item) => (item.id === workspace.id ? workspace : item))
            : [...previous, workspace],
        ),
      )
      setActiveWorkspaceID(workspace.id)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSelecting(false)
    }
  }, [activeWorkspace?.directory, client.workspaces])

  const rename = useCallback(
    async (workspaceID: string, name: string): Promise<Workspace | undefined> => {
      setError(undefined)
      try {
        const updated = await client.workspaces.rename(workspaceID, { name })
        setWorkspaces((previous) =>
          sortWorkspaces(previous.map((workspace) => (workspace.id === workspaceID ? updated : workspace))),
        )
        return updated
      } catch (cause) {
        setError(describeError(cause))
        return undefined
      }
    },
    [client.workspaces],
  )

  const pin = useCallback(
    async (workspaceID: string, pinned: boolean): Promise<Workspace | undefined> => {
      setError(undefined)
      try {
        const updated = await client.workspaces.pin(workspaceID, { pinned })
        setWorkspaces((previous) =>
          sortWorkspaces(previous.map((workspace) => (workspace.id === workspaceID ? updated : workspace))),
        )
        return updated
      } catch (cause) {
        setError(describeError(cause))
        return undefined
      }
    },
    [client.workspaces],
  )

  const clearError = useCallback(() => setError(undefined), [])

  return {
    workspaces,
    activeWorkspace,
    directory: activeWorkspace?.directory,
    label: activeWorkspace === undefined ? undefined : toDisplayPath(activeWorkspace.directory),
    loading,
    selecting,
    error,
    selectWorkspace,
    select,
    rename,
    pin,
    clearError,
  }
}

export const isDefaultWorkspace = (workspace: Workspace): boolean => toDisplayPath(workspace.directory) === "~/easycode"

const sortWorkspaces = (workspaces: Workspace[]): Workspace[] =>
  [...workspaces].sort((left, right) => {
    const leftDefault = isDefaultWorkspace(left)
    const rightDefault = isDefaultWorkspace(right)
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1

    const leftPinned = left.pinnedAt !== undefined
    const rightPinned = right.pinnedAt !== undefined
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
    if (leftPinned && rightPinned) return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)

    return left.createdAt - right.createdAt || left.name.localeCompare(right.name)
  })
