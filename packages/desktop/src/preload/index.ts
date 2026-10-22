import { contextBridge, ipcRenderer } from "electron"

import { IPC_SELECT_DIRECTORY, type SelectDirectoryRequest } from "../shared/ipc"

/**
 * 预加载脚本。
 *
 * 它向渲染层暴露两样东西：
 * 1. 四个常量（Core 服务地址、访问令牌、运行平台、用户主目录），由主进程通过命令行参数一次性注入
 * 2. 一个函数（选择工作目录），走 IPC 调主进程的系统弹窗
 *
 * 除这个函数之外，渲染进程无法触发主进程的任何行为——会话、消息、工具调用
 * 全部走 Core 的 HTTP 接口。之所以目录选择必须例外，是因为渲染进程在沙箱中运行，
 * 既拿不到绝对路径，也没有任何 Web 标准 API 能唤起系统弹窗。
 *
 * 注意这里不能 import 任何 Node 内置模块：预加载脚本运行在沙箱里，
 * 只允许加载 electron、events、timers、url。因此主目录也只能由主进程注入，
 * 而不是在这里调用 os.homedir()。
 */

const ARG_PREFIX = "--easycode-"

const readArgument = (name: string): string => {
  const prefix = `${ARG_PREFIX}${name}=`
  const found = process.argv.find((argument) => argument.startsWith(prefix))
  return found === undefined ? "" : found.slice(prefix.length)
}

const serverUrl = readArgument("server-url")
const serverToken = readArgument("server-token")

if (serverUrl.length === 0) {
  // 走到这里说明主进程没有注入地址，界面只会报「连不上服务」。
  // 明确打一行日志，省去从空白界面反推原因的时间
  console.error("[preload] 未收到 Core 服务地址，界面将无法工作")
}

contextBridge.exposeInMainWorld(
  "easycode",
  Object.freeze({
    serverUrl,
    serverToken,

    /**
     * 运行平台。
     *
     * 界面需要它来适配窗口装饰：macOS 用的是隐藏式标题栏，左上角被系统画了
     * 红绿灯按钮，内容必须让出那块位置；Windows 与 Linux 则不需要。
     */
    platform: process.platform,

    /**
     * 用户主目录。
     *
     * 界面用它把绝对路径显示成 `~/xxx`，并在用户还没选过目录时把默认值
     * 展开成可供系统弹窗使用的绝对路径。
     */
    homeDirectory: readArgument("home"),

    /**
     * 打开系统原生的目录选择框。
     *
     * 用户取消时返回 undefined。这是渲染层唯一能调用主进程的能力，见 shared/ipc.ts。
     */
    selectDirectory: (request?: SelectDirectoryRequest): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC_SELECT_DIRECTORY, request) as Promise<string | undefined>,
  }),
)
