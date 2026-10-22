import { z } from "zod"

import { VerificationResult } from "./task.js"

export const ToolEffect = z.enum(["read", "mutation", "command", "state"])

export type ToolEffect = z.infer<typeof ToolEffect>

export const ToolFailureKind = z.enum([
  "invalid_input",
  "not_found",
  "permission",
  "aborted",
  "timeout",
  "command_failed",
  "transient",
  "internal",
])

export type ToolFailureKind = z.infer<typeof ToolFailureKind>

export const ToolVerification = z.object({
  status: VerificationResult,
  command: z.string().optional(),
  summary: z.string(),
})

export type ToolVerification = z.infer<typeof ToolVerification>

/**
 * 工具结果的通用语义。工具自身只声明发生了什么，Runner 根据这些字段推进任务状态。
 */
export const ToolMetadata = z.object({
  effect: ToolEffect.optional(),
  failureKind: ToolFailureKind.optional(),
  retryable: z.boolean().optional(),
  changedPaths: z.array(z.string()).optional(),
  verification: ToolVerification.optional(),
  needsInput: z.boolean().optional(),
})

export type ToolMetadata = z.infer<typeof ToolMetadata>

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
 * 校验与执行由工具注册表负责。
 */
export const ToolCall = z.object({
  callID: z.string(),
  name: z.string(),
  input: z.unknown(),
})

export type ToolCall = z.infer<typeof ToolCall>
