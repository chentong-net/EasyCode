import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Workspace } from "@easycode/schema"
import { z } from "zod"

import { createLogger } from "../log.js"

const logger = createLogger("workspace.store")

const WorkspaceFile = z.object({
  version: z.literal(1),
  workspaces: z.array(Workspace),
})

/** 工作区是应用级数据，独立于单个会话目录保存。 */
export interface WorkspaceStore {
  list(): Promise<Workspace[]>
  write(workspaces: Workspace[]): Promise<void>
}

export const createWorkspaceStore = (dataDir: string): WorkspaceStore => {
  const file = join(dataDir, "workspaces.json")

  const list = async (): Promise<Workspace[]> => {
    let content: string
    try {
      content = await readFile(file, "utf8")
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error(`工作区注册表不是合法 JSON：${file}`, { cause: error })
    }

    const result = WorkspaceFile.safeParse(parsed)
    if (!result.success) {
      throw new Error(`工作区注册表结构不符合预期：${result.error.message}`)
    }
    return result.data.workspaces
  }

  const write = async (workspaces: Workspace[]): Promise<void> => {
    await mkdir(dataDir, { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, workspaces }, null, 2), "utf8")
    await rename(temporary, file)
    logger.debug("工作区注册表已保存", { count: workspaces.length })
  }

  return { list, write }
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
