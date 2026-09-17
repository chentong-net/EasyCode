import { z } from "zod"

/**
 * 发送给模型的工具定义。
 *
 * `parameters` 是 JSON Schema，由工具作者用 zod 声明后转换而来。
 * 不同 provider 对这个字段的命名略有差异（`parameters` / `input_schema`），
 * 统一转换发生在 LLM 协议层，这里只保留规范化之后的中间形态。
 */
export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema 形式的入参定义 */
  parameters: z.record(z.unknown()),
})

export type ToolDefinition = z.infer<typeof ToolDefinition>

/**
 * 模型请求的一次工具调用。
 *
 * `input` 是原始入参（已完成 JSON 解析但尚未按工具 schema 校验），
 * 校验与执行由工具注册中心负责。
 */
export const ToolCall = z.object({
  callID: z.string(),
  name: z.string(),
  input: z.unknown(),
})

export type ToolCall = z.infer<typeof ToolCall>
