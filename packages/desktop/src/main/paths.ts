import { app } from "electron"
import { join } from "node:path"

/**
 * 主进程运行时用到的各个路径。
 *
 * 这些路径必须由主进程算好再传给 sidecar，不能让 sidecar 自己推断：
 * sidecar 的工作目录继承自主进程，而打包后主进程的工作目录可能是任意位置
 * （用户从 Finder 双击启动时甚至是根目录）。靠 cwd 推断是这一类「开发时正常、
 * 打包后读不到 .env」问题的根源。
 */

export interface MainPaths {
  /** sidecar 入口脚本的绝对路径 */
  sidecarEntry: string
  /** 预加载脚本的绝对路径 */
  preloadEntry: string
  /** 渲染层页面入口的绝对路径 */
  rendererHtml: string
  /** 模型配置文件位置 */
  envFile: string
  /** 日志文件位置 */
  logFile: string
  /** sidecar 就绪后写入的握手文件 */
  readyFile: string
}

export const resolveMainPaths = (): MainPaths => {
  // dist/main/index.cjs → 同级目录下找 preload 与 sidecar，上一级找 renderer
  const mainDir = __dirname
  const distDir = join(mainDir, "..")

  const userData = app.getPath("userData")

  return {
    // 打包后 sidecar 被解包到 asar 之外：Node 无法直接执行 asar 归档里的脚本
    sidecarEntry: app.isPackaged
      ? join(process.resourcesPath, "app.asar.unpacked", "dist", "sidecar", "index.cjs")
      : join(distDir, "sidecar", "index.cjs"),
    preloadEntry: join(distDir, "preload", "index.cjs"),
    rendererHtml: join(distDir, "renderer", "index.html"),

    // 开发时读仓库根目录的 .env；打包后读用户数据目录下的 .env，
    // 让用户不必进到应用包内部去改配置
    envFile: app.isPackaged ? join(userData, ".env") : join(app.getAppPath(), "..", "..", ".env"),

    logFile: join(app.getPath("logs"), "easycode.log"),
    readyFile: join(app.getPath("temp"), `easycode-ready-${process.pid}.json`),
  }
}
