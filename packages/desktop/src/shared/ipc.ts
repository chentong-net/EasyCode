/**
 * 主进程与渲染进程之间的 IPC 契约。
 *
 * EasyCode 的全部业务能力都走 Core 的 HTTP 接口，渲染进程不通过 IPC 做任何
 * 「业务」调用。这里只保留唯一一处**无法绕开**的能力：系统原生的目录选择弹窗。
 *
 * 为什么它绕不开：渲染进程在沙箱里运行，拿不到用户选中的绝对路径，
 * 也没有任何 Web 标准 API 能唤起 macOS 的目录选择器。只有主进程的
 * `dialog.showOpenDialog` 能做到。为它单独开一条通道是划算的——
 * 代价是一个函数，收益是不必为了选目录而退化成让用户手打路径。
 *
 * 通道名与入参出参在此集中定义：主进程与预加载脚本分别打包，各写一份字符串
 * 迟早会因为改名而对不上，而且失败时表现为「点了没反应」，很难排查。
 */

export const IPC_SELECT_DIRECTORY = "easycode:select-directory"

export interface SelectDirectoryRequest {
  /**
   * 弹窗打开时的起始目录。
   *
   * 支持以 `~` 开头，由主进程负责展开（只有主进程知道用户主目录）。
   */
  defaultPath?: string
}

/** 用户确认后返回选中的绝对路径；取消则返回 undefined。 */
export type SelectDirectoryResult = string | undefined
