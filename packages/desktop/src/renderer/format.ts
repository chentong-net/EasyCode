import type { Usage } from "@easycode/schema"

/** 界面上的杂项格式化。集中在一处，避免同一个数字在不同组件里显示成不同样子。 */

/** 把任意异常转成一行可读文案。 */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 把 token 数格式化成紧凑形式。界面上不需要精确到个位。 */
export const formatTokens = (value: number): string => {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * 当前界面的 token 合计口径。
 *
 * `input` 与 `cacheRead` / `cacheWrite` 互不重叠，三者相加才是输入总量；
 * 但协议层映射后的 `output` 已经包含 `reasoning`，本函数又加了一次 `reasoning`。
 * 因此当前结果会重复计入 reasoning token，不应把它当作严格的用量总和。
 */
export const usageTotal = (usage: Usage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite + usage.output + usage.reasoning

/** 相对时间格式化工具。当前侧边栏未展示时间，此函数保留供后续界面使用。 */
export const formatRelativeTime = (timestamp: number): string => {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString("zh-CN")
}

/** 工具入参压成单行，供卡片标题展示。 */
export const summarizeToolInput = (input: unknown, limit = 120): string => {
  if (input === undefined || input === null) return ""
  let text: string
  try {
    text = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return "(入参无法序列化)"
  }
  const flat = text.replace(/\s+/g, " ")
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}
