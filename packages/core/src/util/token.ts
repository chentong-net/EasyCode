/**
 * token 估算。
 *
 * 估算值只用于两个用途：判断是否需要压缩、以及在 UI 上显示上下文占用。
 * 真实用量永远以 provider 返回的 usage 为准。
 *
 * 不能直接用「字符数 / 4」：那是英文的经验值，而中文一个字大约对应一个 token，
 * 若按 4 个字符算一个 token，中文内容的估算值会只有实际值的四分之一。
 * 估算偏小意味着「以为还有空间」，结果就是撞上上下文超限被服务端拒绝。
 * 所以这里按字符类型分别计算：CJK 字符按 1 个 token，其余按 4 字符 1 个 token。
 */

/** CJK 及全角标号字符范围：中日韩文字、假名、全角符号。 */
const WIDE_TEXT = /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff]/g

export const estimateTextTokens = (text: string): number => {
  if (text.length === 0) return 0
  const wideCharacters = text.match(WIDE_TEXT)?.length ?? 0
  const narrowCharacters = text.length - wideCharacters
  return wideCharacters + Math.ceil(narrowCharacters / 4)
}

/**
 * 额外的结构性开销。
 *
 * 每条消息在 provider 侧都会被包装成带角色标记的结构，工具定义与工具调用
 * 也会有固定的协议开销。按条数与工具数粗略补偿，避免系统性低估。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4
export const TOOL_OVERHEAD_TOKENS = 12
