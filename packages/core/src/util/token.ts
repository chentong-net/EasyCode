/**
 * token 估算。
 *
 * 估算值只用于两个用途：判断是否需要执行 compaction（压缩），以及在 UI 上显示上下文占用。
 * 真实用量永远以 provider 返回的 usage 为准。
 *
 * 不能直接用「字符数 / 4」：那是普通英文的经验值，而中文一个字大约对应一个 token。
 * Coding Agent 的历史里还有大量代码、路径、JSON 和工具 Schema，它们通常比普通英文
 * 更 token 密集，因此其余字符按 3 个字符 1 token 保守估算，减少临界上下文超限。
 */

/** CJK 及全角标号字符范围：中日韩文字、假名、全角符号。 */
const WIDE_TEXT = /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff]/g

export const estimateTextTokens = (text: string): number => {
  if (text.length === 0) return 0
  const wideCharacters = text.match(WIDE_TEXT)?.length ?? 0
  const narrowCharacters = text.length - wideCharacters
  return wideCharacters + Math.ceil(narrowCharacters / 3)
}

/**
 * 额外的结构性开销。
 *
 * 每条消息在 provider 侧都会被包装成带角色标记的结构，工具定义与工具调用
 * 也会有固定的协议开销。按条数与工具数粗略补偿，避免系统性低估。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4
export const TOOL_OVERHEAD_TOKENS = 12
