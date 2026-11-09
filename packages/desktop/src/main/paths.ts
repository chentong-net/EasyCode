import { app } from "electron"
import { join } from "node:path"

/**
 * 主进程运行时用到的各个路径。
 *
 * 这些路径必须由主进程算好再传给 sidecar，不能让 sidecar 自己推断。
 * 打包后主进程的工作目录可能是任意位置（用户从 Finder 双击启动时甚至是根目录）；
 * startSidecar 会显式把子进程 cwd 设置为配置文件所在目录。
 */

export interface MainPaths {
  /** sidecar 入口脚本的绝对路径 */
  sidecarEntry: string
  /** 预加载脚本的绝对路径 */
  preloadEntry: string
  /** 渲染层构建产物目录，由 app:// 协议映射出去 */
  rendererDir: string
  /** 固定内部状态目录。 */
  dataDir: string
  /** 固定 TOML 配置文件位置。 */
  configFile: string
  /** 日志文件位置 */
  logFile: string
  /** sidecar 就绪后写入的握手文件 */
  readyFile: string
}

export const resolveMainPaths = (): MainPaths => {
  // dist/main/index.cjs → 同级目录下找 preload 与 sidecar，上一级找 renderer
  const distDir = join(__dirname, "..")

  const easycodeHome = join(app.getPath("home"), "easycode")
  const dataDir = join(easycodeHome, ".easycode")

  return {
    // 打包后 sidecar 被解包到 asar 之外：Node 无法直接执行 asar 归档里的脚本
    sidecarEntry: app.isPackaged
      ? join(process.resourcesPath, "app.asar.unpacked", "dist", "sidecar", "index.cjs")
      : join(distDir, "sidecar", "index.cjs"),
    preloadEntry: join(distDir, "preload", "index.cjs"),
    rendererDir: join(distDir, "renderer"),

    dataDir,
    configFile: join(dataDir, "config.toml"),
    logFile: join(dataDir, "logs", "easycode.log"),
    readyFile: join(app.getPath("temp"), `easycode-ready-${process.pid}.json`),
  }
}
