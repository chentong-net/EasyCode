import { homedir } from "node:os"
import { resolve } from "node:path"

/**
 * 展开路径开头的 `~`。
 *
 * Node 的 `path.resolve` 不认识 `~`，会把它当成一个普通目录名，于是
 * `~/easycode` 会变成 `<当前工作目录>/~/easycode`：目录确实被创建了，
 * 位置却完全不对，而且不会报任何错。用户只会发现「文件出现在了奇怪的地方」。
 *
 * 所有来自配置或用户输入的路径都必须先过这里，再交给 resolve。
 */
export const expandHome = (value: string): string => {
  if (value === "~") return homedir()
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2))
  return value
}
