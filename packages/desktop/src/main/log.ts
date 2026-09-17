import { appendFileSync } from "node:fs"

/**
 * 主进程日志。
 *
 * 刻意不复用 @easycode/core 的 logger：主进程需要记录的只有启动、退出
 * 和 sidecar 的异常这几件事，为此把整个 Agent 运行时打进主进程包并不划算。
 * 日志格式与 Core 保持一致，便于在同一个文件里阅读。
 *
 * 与 Core 的 logger 一样，日志写 stderr 而不是 stdout，也不会因为落盘失败而中断流程。
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

let logFile: string | undefined

/** 设置日志文件路径。必须在第一次记录日志之前调用。 */
export const setLogFile = (file: string): void => {
  logFile = file
}

const write = (level: LogLevel, message: string, data?: unknown): void => {
  const detail =
    data === undefined
      ? ""
      : data instanceof Error
        ? ` ${data.stack ?? data.message}`
        : ` ${safeStringify(data)}`

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [main] ${message}${detail}`
  process.stderr.write(`${line}\n`)

  if (!logFile) return
  try {
    appendFileSync(logFile, `${line}\n`)
  } catch {
    // 落盘失败只忽略：日志是观测手段，不是功能
  }
}

export const log = {
  debug: (message: string, data?: unknown): void => write("debug", message, data),
  info: (message: string, data?: unknown): void => write("info", message, data),
  warn: (message: string, data?: unknown): void => write("warn", message, data),
  error: (message: string, data?: unknown): void => write("error", message, data),
}

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return "[附加数据无法序列化为 JSON]"
  }
}
