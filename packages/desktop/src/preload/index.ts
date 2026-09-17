import { contextBridge } from "electron"

/**
 * 预加载脚本。
 *
 * 它是渲染进程与主进程之间唯一的接口，而且**只出不进**：
 * 主进程把「服务地址 + 访问令牌」通过命令行参数塞进来，这里取出后挂到 window 上。
 * 渲染进程没有任何回调可以触发主进程行为，也不需要 ——
 * 所有能力都由 Core 的 HTTP 接口提供。
 *
 * 为什么用命令行参数而不是 IPC：这是一个一次性的常量注入，
 * 注入完就再也不需要通信了。为它开一条 IPC 通道等于白白多一套需要维护的协议。
 */

const ARG_PREFIX = "--easycode-server-"

const readArgument = (name: string): string => {
  const prefix = `${ARG_PREFIX}${name}=`
  const found = process.argv.find((argument) => argument.startsWith(prefix))
  return found === undefined ? "" : found.slice(prefix.length)
}

const serverUrl = readArgument("url")
const serverToken = readArgument("token")

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
     * 这类信息只能由主进程侧提供，渲染进程无法自行推断。
     */
    platform: process.platform,
  }),
)
