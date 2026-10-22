import { z } from "zod"

/**
 * 一次模型调用返回的 token 用量。
 *
 * 语义说明：`input` 是「未命中缓存、按完整价格计费」的输入 token，
 * 与 `cacheRead` / `cacheWrite` 互不重叠，三者相加才是输入总量。
 * `output` 是模型生成的总量，按当前 OpenAI 兼容协议映射约定包含 `reasoning`；
 * 计算总输出时不能再次加上 `reasoning`。
 * 这样设计可以避免下游做减法时出现负数（各家 provider 的 usage 字段语义不一致）。
 */
export const Usage = z.object({
  /** 未命中缓存的输入 token */
  input: z.number().int().nonnegative(),
  /** 模型生成的 token */
  output: z.number().int().nonnegative(),
  /** 推理过程消耗的 token（部分模型会单独返回） */
  reasoning: z.number().int().nonnegative(),
  /** 命中缓存的输入 token */
  cacheRead: z.number().int().nonnegative(),
  /** 写入缓存的输入 token */
  cacheWrite: z.number().int().nonnegative(),
})

export type Usage = z.infer<typeof Usage>

/** 全零用量，用于 provider 未返回 usage 的场景（例如流式中途失败）。 */
export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

/** 把两次用量相加，用于会话级别的累计统计。 */
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
