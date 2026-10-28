import { mkdir, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

import type { Session, Workspace } from "@easycode/schema"

import { newWorkspaceID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import { expandHome } from "../util/path.js"
import { createWorkspaceStore } from "./store.js"

export interface WorkspaceManager {
  /** 全部工作区，按创建时间排列。 */
  list(): Promise<Workspace[]>
  /** 添加目录；目录已经登记时直接返回已有工作区。 */
  add(directory: string): Promise<Workspace>
  /** 只修改工作区显示名称。 */
  rename(id: string, name: string): Promise<Workspace>
  /** 置顶或取消置顶；默认工作区始终固定第一。 */
  pin(id: string, pinned: boolean): Promise<Workspace>
  /** 删除非默认工作区及其会话记录，不删除磁盘目录。 */
  delete(id: string): Promise<{ deletedSessions: number }>
}

export interface WorkspaceManagerDeps {
  dataDir: string
  /** 用于把升级前创建的会话目录补建为工作区。 */
  listSessions: () => Promise<Session[]>
  /** 删除目录下的全部会话记录。 */
  deleteSessionsByDirectory: (directory: string) => Promise<number>
  logger?: Logger
}

export class WorkspaceDeleteError extends Error {
  constructor(
    readonly code: "not_found" | "default_workspace",
    message: string,
  ) {
    super(message)
    this.name = "WorkspaceDeleteError"
  }
}

export const createWorkspaceManager = (deps: WorkspaceManagerDeps): WorkspaceManager => {
  const logger = deps.logger ?? createLogger("workspace")
  const store = createWorkspaceStore(deps.dataDir)
  const defaultDirectory = resolve(expandHome("~/easycode"))
  let writes = Promise.resolve()

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation)
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const synchronizeSessions = async (): Promise<Workspace[]> => {
    const stored = await store.list()
    let changed = false
    const workspaces = stored.map((workspace) => {
      if (
        workspace.directory !== defaultDirectory ||
        workspace.name !== (basename(workspace.directory) || workspace.directory)
      ) {
        return workspace
      }
      changed = true
      return { ...workspace, name: "默认工作区" }
    })
    if (!workspaces.some((workspace) => workspace.directory === defaultDirectory)) {
      await mkdir(defaultDirectory, { recursive: true })
      const now = Date.now()
      workspaces.push({
        id: newWorkspaceID(),
        name: "默认工作区",
        directory: defaultDirectory,
        createdAt: now,
        updatedAt: now,
      })
      changed = true
    }

    const knownDirectories = new Set(workspaces.map((workspace) => workspace.directory))
    const additions: Workspace[] = []

    for (const session of await deps.listSessions()) {
      if (knownDirectories.has(session.directory)) continue
      knownDirectories.add(session.directory)
      additions.push({
        id: newWorkspaceID(),
        name: workspaceName(session.directory, defaultDirectory),
        directory: session.directory,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
    }

    if (additions.length === 0 && !changed) return workspaces
    const merged = [...workspaces, ...additions]
    await store.write(merged)
    if (additions.length > 0) logger.info("已从既有会话补建工作区", { count: additions.length })
    return merged
  }

  const list = (): Promise<Workspace[]> =>
    exclusive(async () =>
      [...(await synchronizeSessions())].sort((left, right) => compareWorkspaces(left, right, defaultDirectory)),
    )

  const add = (input: string): Promise<Workspace> =>
    exclusive(async () => {
      const directory = await validateDirectory(input)
      const current = await synchronizeSessions()
      const existing = current.find((workspace) => workspace.directory === directory)
      if (existing) return existing

      const now = Date.now()
      const workspace: Workspace = {
        id: newWorkspaceID(),
        name: workspaceName(directory, defaultDirectory),
        directory,
        createdAt: now,
        updatedAt: now,
      }
      await store.write([...current, workspace])
      logger.info("已添加工作区", { workspaceID: workspace.id, directory })
      return workspace
    })

  const rename = (id: string, input: string): Promise<Workspace> =>
    exclusive(async () => {
      const name = input.trim()
      if (name.length === 0) throw new Error("工作区名称不能为空")

      const workspaces = await synchronizeSessions()
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      const current = workspaces[index]
      if (!current) throw new Error(`工作区不存在：${id}`)

      const updated: Workspace = { ...current, name, updatedAt: Date.now() }
      workspaces[index] = updated
      await store.write(workspaces)
      logger.info("已重命名工作区", { workspaceID: id, name })
      return updated
    })

  const pin = (id: string, pinned: boolean): Promise<Workspace> =>
    exclusive(async () => {
      const workspaces = await synchronizeSessions()
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      const current = workspaces[index]
      if (!current) throw new Error(`工作区不存在：${id}`)
      if (current.directory === defaultDirectory) throw new Error("默认工作区始终固定置顶")

      const now = Date.now()
      const updated: Workspace = { ...current, updatedAt: now }
      if (pinned) updated.pinnedAt = now
      else delete updated.pinnedAt
      workspaces[index] = updated
      await store.write(workspaces)
      logger.info(pinned ? "已置顶工作区" : "已取消置顶工作区", { workspaceID: id })
      return updated
    })

  const remove = (id: string): Promise<{ deletedSessions: number }> =>
    exclusive(async () => {
      const workspaces = await synchronizeSessions()
      const current = workspaces.find((workspace) => workspace.id === id)
      if (!current) throw new WorkspaceDeleteError("not_found", `工作区不存在：${id}`)
      if (current.directory === defaultDirectory) {
        throw new WorkspaceDeleteError("default_workspace", "默认工作区不能删除")
      }

      const deletedSessions = await deps.deleteSessionsByDirectory(current.directory)
      await store.write(workspaces.filter((workspace) => workspace.id !== id))
      logger.info("已删除工作区", { workspaceID: id, directory: current.directory, deletedSessions })
      return { deletedSessions }
    })

  return { list, add, rename, pin, delete: remove }
}

const validateDirectory = async (input: string): Promise<string> => {
  const directory = resolve(expandHome(input))
  const metadata = await stat(directory).catch((error: unknown) => {
    throw new Error(`工作区目录不存在或无法访问：${directory}`, { cause: error })
  })
  if (!metadata.isDirectory()) throw new Error(`工作区路径不是目录：${directory}`)
  return directory
}

const workspaceName = (directory: string, defaultDirectory: string): string =>
  directory === defaultDirectory ? "默认工作区" : basename(directory) || directory

const compareWorkspaces = (left: Workspace, right: Workspace, defaultDirectory: string): number => {
  const leftDefault = left.directory === defaultDirectory
  const rightDefault = right.directory === defaultDirectory
  if (leftDefault !== rightDefault) return leftDefault ? -1 : 1

  const leftPinned = left.pinnedAt !== undefined
  const rightPinned = right.pinnedAt !== undefined
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
  if (leftPinned && rightPinned) return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0)

  return left.createdAt - right.createdAt || left.name.localeCompare(right.name)
}
