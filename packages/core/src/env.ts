import { existsSync, readFileSync } from "node:fs"

import { createLogger } from "./log.js"

const logger = createLogger("env")

/**
 * 极简 .env 加载器。
 *
 * 刻意不引入 dotenv 依赖：需要的功能只有「读文件、按行解析 KEY=VALUE、写入 process.env」，
 * 三十行就能覆盖，而且能完全掌控三个容易出错的语义：
 *
 * 1. **已存在的环境变量优先**。真实环境变量 > .env 文件，这样启动脚本和测试
 *    可以临时覆盖配置，不会被 .env 里写死的值挡住。
 * 2. **支持注释、空行、引号、`export` 前缀**，这是 .env 事实上的通用语法。
 * 3. **文件不存在时静默通过**，只写一条 debug 日志。生产环境靠进程环境变量注入，
 *    没有 .env 是完全正常的。
 */
export const loadEnvFile = (filePath: string): void => {
  if (!existsSync(filePath)) {
    logger.debug("未找到 .env 文件，跳过加载", { filePath })
    return
  }

  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch (error) {
    logger.warn("读取 .env 文件失败，将只使用进程环境变量", { filePath, error })
    return
  }

  let applied = 0
  for (const rawLine of content.split("\n")) {
    const parsed = parseLine(rawLine)
    if (!parsed) continue
    if (process.env[parsed.key] !== undefined) continue
    process.env[parsed.key] = parsed.value
    applied += 1
  }

  logger.info("已加载 .env 配置", { filePath, appliedCount: applied })
}

/** 解析一行配置；注释、空行、格式不正确的行都返回 undefined。 */
const parseLine = (rawLine: string): { key: string; value: string } | undefined => {
  const line = rawLine.trim()
  if (line.length === 0 || line.startsWith("#")) return undefined

  // 兼容 shell 风格的 `export KEY=VALUE`
  const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line

  const separator = normalized.indexOf("=")
  if (separator <= 0) return undefined

  const key = normalized.slice(0, separator).trim()
  const rawValue = normalized.slice(separator + 1).trim()
  if (key.length === 0) return undefined

  return { key, value: stripQuotes(rawValue) }
}

const stripQuotes = (value: string): string => {
  const isQuoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  return isQuoted ? value.slice(1, -1) : value
}
