/**
 * 预加载脚本注入信息的访问层。
 *
 * 界面里所有对 `window.easycode` 的直接访问都收在这里，好处有两个：
 * - 桥接对象是可选的（在浏览器里直接打开页面时不存在），集中处理一次即可，
 *   不必在每个用到的地方都写一遍可空判断
 * - 路径展示、目录选择这类「和宿主环境相关」的逻辑有了唯一的归属地
 */

const bridge = window.easycode

/** 是否运行在桌面端外壳里。为假时界面只能展示无法工作的提示。 */
export const hasHost = bridge !== undefined && bridge.serverUrl.length > 0

/** 运行平台，取值同 Node 的 process.platform */
export const platform = bridge?.platform ?? "unknown"

/** 用户主目录。用于把绝对路径显示成 `~/xxx`。 */
const homeDirectory = bridge?.homeDirectory ?? ""

/**
 * 把绝对路径转成展示用的短路径。
 *
 * 主目录下的路径显示成 `~` 开头：既短又能让用户立刻认出位置，
 * 而且不必把用户名暴露在界面上。
 */
export const toDisplayPath = (absolute: string): string => {
  if (homeDirectory.length === 0) return absolute
  if (absolute === homeDirectory) return "~"
  if (absolute.startsWith(`${homeDirectory}/`)) return `~${absolute.slice(homeDirectory.length)}`
  return absolute
}

/**
 * 打开系统原生的目录选择框。
 *
 * 用户取消时返回 undefined。这是渲染层唯一会调用主进程的地方，
 * 原因是沙箱里的网页没有任何办法唤起系统弹窗、也拿不到绝对路径。
 */
export const selectDirectory = async (defaultPath?: string): Promise<string | undefined> => {
  if (bridge === undefined) return undefined
  return bridge.selectDirectory(defaultPath === undefined ? {} : { defaultPath })
}
