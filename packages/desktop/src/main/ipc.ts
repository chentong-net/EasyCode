import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { app, dialog, ipcMain } from "electron"

import { IPC_RESTART_APP, IPC_SELECT_DIRECTORY, type SelectDirectoryRequest } from "../shared/ipc"
import { log } from "./log"

/**
 * 主进程侧唯一的一处 IPC。
 *
 * 提供两个只能在宿主侧完成的能力：目录选择和配置生效后的应用重启。
 *
 * 通道只注册一次，且在 app ready 之后调用。
 */
export const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_SELECT_DIRECTORY, async (_event, request?: SelectDirectoryRequest): Promise<string | undefined> => {
    const defaultPath = resolveDefaultPath(request?.defaultPath)
    log.debug("打开目录选择弹窗", { defaultPath })

    const result = await dialog.showOpenDialog({
      title: "选择工作目录",
      buttonLabel: "选择",
      // createDirectory 让用户可以直接在弹窗里新建目录，
      // 否则第一次使用时会因为目标目录还不存在而无从下手
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath === undefined ? {} : { defaultPath }),
    })

    if (result.canceled || result.filePaths.length === 0) {
      log.debug("用户取消了目录选择")
      return undefined
    }

    const selected = result.filePaths[0]
    log.info("用户选择了工作目录", { directory: selected })
    return selected
  })

  ipcMain.handle(IPC_RESTART_APP, async (): Promise<void> => {
    log.info("用户请求重启应用以应用配置")
    setImmediate(() => {
      app.relaunch()
      app.quit()
    })
  })
}

/** 展开 `~` 并回退到最近的已存在目录：起始目录不存在时弹窗会打开在奇怪的位置。 */
const resolveDefaultPath = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined

  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value

  let current = expanded
  while (!existsSync(current)) {
    const parent = dirname(current)
    // 已经到根目录还是不存在，只能交给系统决定打开位置
    if (parent === current) return undefined
    current = parent
  }
  return current
}
