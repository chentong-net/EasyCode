import { DEFAULT_WORKSPACE_DIRECTORY } from "@easycode/protocol"
import { useCallback, useState } from "react"

import { selectDirectory, toDisplayPath } from "./bridge"

/**
 * 当前工作目录。
 *
 * 这是应用级的设置，不是会话级的：侧边栏只列出该目录下的会话，
 * 「新建会话」也总是建在这个目录里。会话创建后其目录不再改变，
 * 因此它同时也是「agent 能在哪里动手」的边界。
 *
 * 选择用系统原生弹窗而不是输入框：用户需要的是一个真实的目录，
 * 手打路径既容易写错，也无法确认目录是否真的存在。
 */

/** 持久化用的键。目录是用户的选择，重开应用后不应该重新问一遍。 */
const STORAGE_KEY = "easycode.workspace"

export interface WorkspaceState {
  /** 当前工作目录的绝对路径。undefined 表示用户还没选过。 */
  directory: string | undefined
  /** 展示用的短路径，例如 ~/easycode */
  label: string | undefined
  /** 是否正在等待用户在弹出的窗口里做选择 */
  selecting: boolean
  select(): Promise<void>
}

export const useWorkspace = (): WorkspaceState => {
  const [directory, setDirectory] = useState<string | undefined>(readStored)
  const [selecting, setSelecting] = useState(false)

  const select = useCallback(async () => {
    setSelecting(true)
    try {
      // 第一次打开时把弹窗定位到默认工作目录，省掉用户逐级点进去的步骤。
      // 目录不存在时由主进程回退到最近的上级目录
      const picked = await selectDirectory(directory ?? DEFAULT_WORKSPACE_DIRECTORY)
      if (picked === undefined) return
      writeStored(picked)
      setDirectory(picked)
    } finally {
      setSelecting(false)
    }
  }, [directory])

  return {
    directory,
    label: directory === undefined ? undefined : toDisplayPath(directory),
    selecting,
    select,
  }
}

/**
 * 读取上次选择的目录。
 *
 * localStorage 在某些情况下会抛错（隐私模式、存储被禁用），
 * 这时退化成「每次启动都要重新选一次」即可，不该让整个界面起不来。
 */
const readStored = (): string | undefined => {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value !== null && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

const writeStored = (directory: string): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, directory)
  } catch {
    // 存不下只是下次要重选，不影响本次使用
  }
}
