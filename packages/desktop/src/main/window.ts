import { BrowserWindow, shell } from "electron"

import { log } from "./log"

/**
 * 主窗口。
 *
 * 渲染进程与 Core 之间没有任何直连：所有能力都通过 HTTP 接口暴露，
 * 主进程只负责把「服务地址 + 访问令牌」这两样东西交给预加载脚本。
 * 这样渲染进程就不需要（也无法）接触文件系统与进程 —— 它的权限被降到了
 * 一个普通网页的水平，即使界面代码出了漏洞，能造成的破坏也限于接口本身。
 */

export interface MainWindowOptions {
  /** Core 服务的地址 */
  serverUrl: string
  /** 访问令牌 */
  serverToken: string
  /** 预加载脚本绝对路径 */
  preloadEntry: string
  /** 页面入口绝对路径 */
  rendererHtml: string
}

export const createMainWindow = (options: MainWindowOptions): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: "EasyCode",
    // 与界面底色一致：窗口出现的瞬间不会闪一下白屏
    backgroundColor: "#12151c",
    // macOS 上用隐藏式标题栏，让侧边栏区域可以延伸到顶部
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: options.preloadEntry,
      // 下面三项是安全基线，任何一项都不该为了「方便」而关掉：
      // 渲染进程运行的是模型产出的内容，必须当作不可信代码对待
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 配置传递的唯一通道。preload 从 process.argv 里取出这两项后交给渲染层，
      // 单向注入，渲染进程无法反向调用主进程的任何能力
      additionalArguments: [
        `--easycode-server-url=${options.serverUrl}`,
        `--easycode-server-token=${options.serverToken}`,
      ],
    },
  })

  // 等页面渲染出第一帧再显示，避免用户看到一闪而过的空窗口
  window.once("ready-to-show", () => window.show())

  // 外部链接交给系统浏览器。不这样做的话，点开一个链接会把整个应用
  // 导航成一个没有 preload 的普通网页，界面直接不可用
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  void window.loadFile(options.rendererHtml).catch((error) => {
    log.error("加载界面失败", { html: options.rendererHtml, error })
  })

  return window
}
