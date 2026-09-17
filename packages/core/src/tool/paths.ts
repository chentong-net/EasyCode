import { isAbsolute, relative, resolve } from "node:path"

import type { ToolContext } from "./tool.js"

/**
 * 工具路径解析与工作目录边界检查。
 *
 * 所有涉及文件系统的工具都必须走这里。原因是 agent 拿到的路径来自模型，
 * 完全不可信：它可能写出 `../../.ssh/id_rsa` 这样的路径。
 * 越过工作目录不会被直接拒绝，而是触发一次授权确认——那是用户的知情选择。
 */

export interface ResolvedPath {
  /** 绝对路径 */
  absolute: string
  /** 是否位于工作目录之外 */
  external: boolean
  /** 展示与权限申请用的路径形式：目录内用相对路径，目录外用绝对路径 */
  display: string
}

export const resolveToolPath = (directory: string, input: string): ResolvedPath => {
  const absolute = resolve(directory, input)
  const relativePath = relative(directory, absolute)
  const external = relativePath.startsWith("..") || isAbsolute(relativePath)

  return {
    absolute,
    external,
    // 目录内统一用相对路径，日志和授权卡片都更易读；
    // 目录外必须给绝对路径，否则用户看不出到底要访问哪里
    display: external ? absolute : relativePath === "" ? "." : relativePath,
  }
}

/**
 * 若路径在工作目录之外，申请一次外部目录访问授权。
 *
 * 这类授权刻意不支持「总是允许」：外部目录的访问范围无法用一条规则概括，
 * 记住它等于给了 agent 访问整台机器的永久许可。
 */
export const ensureWithinWorkspace = async (path: ResolvedPath, context: ToolContext): Promise<void> => {
  if (!path.external) return
  await context.authorize({ action: "external_directory", resources: [path.absolute], save: [] })
}
