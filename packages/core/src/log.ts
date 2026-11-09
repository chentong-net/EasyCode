import { appendFileSync } from "node:fs"

/**
 * EasyCode 的日志工具。
 *
 * 三条设计约束：
 *
 * 1. 所有日志写 stderr，绝不写 stdout。CLI 的 stdout 专门用于输出 agent 的回复，
 *    一旦混入日志，管道重定向（`easycode run "..." > out.txt`）就会拿到脏数据。
 * 2. 日志级别由 config.toml 在启动时配置一次；配置解析完成前使用 info。
 * 3. 落盘失败绝不影响主流程：日志是观测手段，不是功能。
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
  /** 派生出带子作用域的 logger，例如 "runner" → "runner.turn" */
  child(scope: string): Logger
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

let configuredLevel: LogLevel = "info"

/** 应用 config.toml 中的日志级别。配置保存后需要重启才能改变当前进程。 */
export const setLogLevel = (level: LogLevel): void => {
  configuredLevel = level
}

/** 把附加数据格式化成一行文本。Error 对象优先取堆栈，便于排查。 */
const formatData = (data: unknown): string => {
  if (data === undefined) return ""
  if (data instanceof Error) return ` ${data.stack ?? data.message}`
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return " [附加数据无法序列化为 JSON]"
  }
}

const write = (level: LogLevel, scope: string, message: string, data: unknown): void => {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel]) return

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${formatData(data)}`
  process.stderr.write(`${line}\n`)

  // 桌面端会设置 EASYCODE_LOG_FILE，把日志落盘以便排查用户侧问题
  const file = process.env.EASYCODE_LOG_FILE
  if (!file) return
  try {
    appendFileSync(file, `${line}\n`)
  } catch {
    // 落盘失败（磁盘满、权限不足等）只忽略，不影响主流程
  }
}

/** 创建一个带作用域名的 logger。作用域名会出现在每条日志里，用于区分来源模块。 */
export const createLogger = (scope: string): Logger => ({
  debug: (message, data) => write("debug", scope, message, data),
  info: (message, data) => write("info", scope, message, data),
  warn: (message, data) => write("warn", scope, message, data),
  error: (message, data) => write("error", scope, message, data),
  child: (child) => createLogger(`${scope}.${child}`),
})
