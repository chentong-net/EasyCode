import { realpath, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

import type { Workspace } from "@easycode/schema"

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
}

export interface WorkspaceManagerDeps {
  dataDir: string
  logger?: Logger
}

export const createWorkspaceManager = (deps: WorkspaceManagerDeps): WorkspaceManager => {
  const logger = deps.logger ?? createLogger("workspace")
  const store = createWorkspaceStore(deps.dataDir)
  let writes = Promise.resolve()

  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation)
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const list = async (): Promise<Workspace[]> =>
    [...(await store.list())].sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name))

  const add = (input: string): Promise<Workspace> =>
    exclusive(async () => {
      const directory = await validateDirectory(input)
      const existing = (await store.list()).find((workspace) => workspace.directory === directory)
      if (existing) return existing

      const now = Date.now()
      const workspace: Workspace = {
        id: newWorkspaceID(),
        name: basename(directory) || directory,
        directory,
        createdAt: now,
        updatedAt: now,
      }
      await store.write([...(await store.list()), workspace])
      logger.info("已添加工作区", { workspaceID: workspace.id, directory })
      return workspace
    })

  const rename = (id: string, input: string): Promise<Workspace> =>
    exclusive(async () => {
      const name = input.trim()
      if (name.length === 0) throw new Error("工作区名称不能为空")

      const workspaces = await store.list()
      const index = workspaces.findIndex((workspace) => workspace.id === id)
      const current = workspaces[index]
      if (!current) throw new Error(`工作区不存在：${id}`)

      const updated: Workspace = { ...current, name, updatedAt: Date.now() }
      workspaces[index] = updated
      await store.write(workspaces)
      logger.info("已重命名工作区", { workspaceID: id, name })
      return updated
    })

  return { list, add, rename }
}

const validateDirectory = async (input: string): Promise<string> => {
  const directory = resolve(expandHome(input))
  const metadata = await stat(directory).catch((error: unknown) => {
    throw new Error(`工作区目录不存在或无法访问：${directory}`, { cause: error })
  })
  if (!metadata.isDirectory()) throw new Error(`工作区路径不是目录：${directory}`)
  return realpath(directory)
}
