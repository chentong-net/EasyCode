import { app, BrowserWindow, dialog } from "electron"

import { log, setLogFile } from "./log"
import { resolveMainPaths, type MainPaths } from "./paths"
import { startSidecar, type Sidecar } from "./sidecar"
import { createMainWindow } from "./window"

/**
 * Electron 主进程。
 *
 * 它的职责被刻意压到最小：拉起 Core sidecar、把地址与令牌注入窗口、在退出时收摊。
 * 所有业务逻辑都在 Core 里，因此这里没有一行代码知道「会话」「消息」「工具」是什么。
 * 将来要换成别的外壳（Tauri、浏览器标签页、VS Code 扩展），改的只是这个文件。
 */

let sidecar: Sidecar | undefined
let paths: MainPaths | undefined
/** 是否正在主动退出。用于区分「正常退出」与「sidecar 意外崩溃」。 */
let quitting = false

const bootstrap = async (): Promise<void> => {
  paths = resolveMainPaths()
  setLogFile(paths.logFile)

  log.info("桌面端启动", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    envFile: paths.envFile,
    readyFile: paths.readyFile,
  })

  sidecar = await startSidecar({
    entry: paths.sidecarEntry,
    envFile: paths.envFile,
    logFile: paths.logFile,
    readyFile: paths.readyFile,
  })

  createMainWindow({
    serverUrl: sidecar.url,
    serverToken: sidecar.token,
    preloadEntry: paths.preloadEntry,
    rendererHtml: paths.rendererHtml,
  })

  const current = paths
  sidecar.onExit((code) => {
    if (quitting) return

    // sidecar 意外退出时，窗口里的界面其实还能用，只是所有请求都会失败。
    // 这里选择直接退出而不是重启：重启后端口和令牌都会变，必须重建窗口，
    // 与其做一个半吊子的恢复流程，不如让用户重启应用来得清楚。
    log.error("核心服务意外退出", { code, logFile: current.logFile })
    dialog.showErrorBox(
      "EasyCode 已停止",
      `核心服务意外退出（退出码 ${code}）。\n\n日志文件：${current.logFile}\n\n请重新启动应用。`,
    )
    quitting = true
    app.quit()
  })
}

/* -------------------------------------------------------------------------- */
/* 生命周期                                                                    */
/* -------------------------------------------------------------------------- */

// 单实例锁：同时开两个应用会启动两个 agent 进程，它们共用同一个数据目录，
// 轻则日志交错，重则两个回合同时写同一个会话的事件日志
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    // 用户重复点击图标时，把已有窗口拉到前面，而不是新开一个
    const windows = BrowserWindow.getAllWindows()
    const window = windows[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  void app
    .whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      log.error("启动失败", error)
      dialog.showErrorBox("EasyCode 启动失败", `${message}\n\n日志文件：${paths?.logFile ?? "未生成"}`)
      quitting = true
      app.quit()
    })

  app.on("activate", () => {
    // macOS 上点击 Dock 图标且没有窗口时重新创建（服务还在，直接复用地址）
    if (BrowserWindow.getAllWindows().length > 0) return
    if (!sidecar || !paths) return
    createMainWindow({
      serverUrl: sidecar.url,
      serverToken: sidecar.token,
      preloadEntry: paths.preloadEntry,
      rendererHtml: paths.rendererHtml,
    })
  })

  app.on("window-all-closed", () => {
    // macOS 的惯例是关掉窗口后应用继续驻留，但这里会留下一个后台的 agent 进程，
    // 用户完全看不到它在做什么。统一退出更符合预期。
    app.quit()
  })

  app.on("before-quit", () => {
    quitting = true
    sidecar?.stop()
  })
}
