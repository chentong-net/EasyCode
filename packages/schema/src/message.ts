import { z } from "zod"

import { ToolMetadata } from "./tool.js"
import { Usage } from "./usage.js"

/**
 * 可以发送给模型的内容块。
 *
 * 文本是最常见的形式；文件块用于图片等二进制内容，`data` 为 base64 编码，
 * 保证消息在 JSONL 事件日志和 HTTP 响应中都能无损往返。
 */
export const Content = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("file"),
    /** MIME 类型，例如 image/png */
    mime: z.string(),
    /** base64 编码的内容（不含 data URI 前缀） */
    data: z.string(),
    /** 可选的文件名，用于展示 */
    name: z.string().optional(),
  }),
])

export type Content = z.infer<typeof Content>

/**
 * 工具调用的执行状态。
 *
 * `pending` 表示调用已记录但尚未执行完成；这个中间态会被持久化，
 * 因此进程在工具执行期间崩溃时，重启后能从历史中看到哪些调用悬空了。
 */
export const ToolState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
  }),
  z.object({
    status: z.literal("success"),
    /** 结构化结果，供 UI 展示使用 */
    output: z.unknown(),
    /** 发给模型的内容块，已通过输出截断限制大小 */
    content: z.array(Content),
    /** 因超出截断阈值而落盘的完整输出文件路径 */
    outputPaths: z.array(z.string()),
    /** 副作用、修改文件和验证结果等结构化语义 */
    metadata: ToolMetadata.optional(),
  }),
  z.object({
    status: z.literal("error"),
    error: z.string(),
    /** 失败时仍可保留模型可见输出和 UI 展示数据 */
    output: z.unknown().optional(),
    content: z.array(Content).optional(),
    outputPaths: z.array(z.string()).optional(),
    metadata: ToolMetadata.optional(),
  }),
])

export type ToolState = z.infer<typeof ToolState>

/**
 * 消息的组成部分。
 *
 * 一条助手消息通常由若干 part 组成：可能先有 reasoning，再有 text，
 * 中间夹着若干 tool 调用。part 的顺序即模型输出的顺序。
 */
export const Part = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("reasoning"),
    /** 推理过程文本，是否展示给用户由 UI 决定 */
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool"),
    callID: z.string(),
    name: z.string(),
    /** 模型给出的入参，已完成 schema 校验 */
    input: z.unknown(),
    state: ToolState,
  }),
  z.object({
    type: z.literal("file"),
    mime: z.string(),
    data: z.string(),
    name: z.string().optional(),
  }),
])

export type Part = z.infer<typeof Part>

/** 所有消息共有的字段。 */
const messageBase = {
  id: z.string(),
  createdAt: z.number(),
}

/** 用户消息：由一条已转为可见消息的输入产生。 */
export const UserMessage = z.object({
  ...messageBase,
  role: z.literal("user"),
  parts: z.array(Part),
})

export type UserMessage = z.infer<typeof UserMessage>

/**
 * 助手消息：一次 provider turn（模型调用轮次）产生一条。
 *
 * 注意这里把 usage / finish / error 直接挂在消息上，而不是单独建 step 实体，
 * 因为「一次模型调用 = 一条助手消息」是这套设计里的固定对应关系。
 */
export const AssistantMessage = z.object({
  ...messageBase,
  role: z.literal("assistant"),
  /** 产生这条消息的模型 id，用于跨模型切换时判断历史兼容性 */
  model: z.string(),
  parts: z.array(Part),
  /** 结束原因，未结束时为空 */
  finish: z.string().optional(),
  usage: Usage.optional(),
  /** 本轮失败时的错误信息 */
  error: z.string().optional(),
  /** 本轮结束时间，未结束时为空 */
  completedAt: z.number().optional(),
})

export type AssistantMessage = z.infer<typeof AssistantMessage>

/**
 * 系统消息：上下文来源发生变化时追加的时序指令。
 *
 * 它既可能出现在 compaction（压缩）之后，也可能在此之前因日期等来源变化而出现。
 * 消息采用「追加」而非「改写」系统提示词，目的是让系统提示词前缀在整个
 * epoch（上下文周期）内保持逐字节不变，从而命中 provider 的缓存。
 */
export const SystemMessage = z.object({
  ...messageBase,
  role: z.literal("system"),
  text: z.string(),
})

export type SystemMessage = z.infer<typeof SystemMessage>

/**
 * compaction 生成的 checkpoint（检查点）消息。
 *
 * 历史执行 compaction（压缩）后，被压缩掉的部分由这条消息代替；
 * `recentMessageIDs` 记录执行 compaction 时原样保留的最近若干条消息，
 * 投影时按原顺序拼在摘要之后。
 */
export const CompactionMessage = z.object({
  ...messageBase,
  role: z.literal("compaction"),
  text: z.string(),
  recentMessageIDs: z.array(z.string()),
})

export type CompactionMessage = z.infer<typeof CompactionMessage>

/** 投影后的完整消息联合类型。 */
export const Message = z.discriminatedUnion("role", [
  UserMessage,
  AssistantMessage,
  SystemMessage,
  CompactionMessage,
])

export type Message = z.infer<typeof Message>
