import { z } from "zod"

import { Content } from "./message.js"
import { PermissionReply } from "./permission.js"
import { Session, Todo } from "./session.js"
import { TaskState } from "./task.js"
import { ToolMetadata } from "./tool.js"
import { Usage } from "./usage.js"

/**
 * 用户输入的投递方式。
 *
 * - `steer`：插话。在当前回合尚未结束时，于下一个安全的 provider turn（模型调用轮次）边界
 *   转为可见消息，让模型立刻调整方向。
 * - `queue`：排队。在当前回合彻底结束、会话即将空闲时才转为可见消息，
 *   一次只转换一条，然后重新判断是否还需要继续。
 */
export const Delivery = z.enum(["steer", "queue"])

export type Delivery = z.infer<typeof Delivery>

/** 所有事件共有的字段。 */
const envelope = {
  sessionID: z.string(),
  /** 毫秒时间戳 */
  timestamp: z.number(),
}

/**
 * 持久化事件共有的字段。
 *
 * `seq` 是会话内单调自增的序号，从 1 开始。它是重放的唯一依据：
 * SSE 断线后带上 `after=seq` 就能接着推，UI 也用它做去重。
 */
const durableEnvelope = {
  ...envelope,
  seq: z.number().int().positive(),
}

/**
 * 会话创建。它是每个会话事件日志中的第一条事件，
 * 因此重放单条日志就能还原出会话元信息，不需要额外读取 session.json 才能理解上下文。
 */
const SessionCreated = z.object({
  ...durableEnvelope,
  type: z.literal("session.created"),
  session: Session,
})

/** 会话元信息变更（标题、累计用量等）。 */
const SessionUpdated = z.object({
  ...durableEnvelope,
  type: z.literal("session.updated"),
  title: z.string().optional(),
  usage: Usage.optional(),
})

/** 会话级失败，例如请求模型时认证失败、网络不可达。 */
const SessionFailed = z.object({
  ...durableEnvelope,
  type: z.literal("session.failed"),
  message: z.string(),
})

/**
 * 任务清单更新。
 *
 * 由 todowrite 工具触发，整表覆盖而不是增量修改：模型的注意力有限，
 * 让它每次给出完整清单比让它算「哪一项要改」可靠得多。
 */
const SessionTodos = z.object({
  ...durableEnvelope,
  type: z.literal("session.todos"),
  todos: z.array(Todo),
})

/**
 * 当前任务工作记忆的 snapshot（快照）。
 *
 * 任务状态不写进消息历史，避免被 compaction（压缩）当作普通对话处理。Runner 每次
 * 推进阶段、记录修改或验证结果时追加该事件，历史重放可恢复同一份状态。
 */
const TaskUpdated = z.object({
  ...durableEnvelope,
  type: z.literal("task.updated"),
  task: TaskState,
})

/**
 * 输入入队。
 *
 * 这一步只是「持久化接纳」，用户消息还没有进入模型可见的历史。
 * 真正的转换由 InputPromoted 事件完成，两者分离是这套设计的关键：
 * 即使进程在入队后立刻崩溃，用户输入也不会丢失。
 */
const InputAdmitted = z.object({
  ...durableEnvelope,
  type: z.literal("input.admitted"),
  inputID: z.string(),
  text: z.string(),
  delivery: Delivery,
})

/** 输入转为可见消息：从待处理队列移出，成为模型可见的用户消息。 */
const InputPromoted = z.object({
  ...durableEnvelope,
  type: z.literal("input.promoted"),
  inputID: z.string(),
  messageID: z.string(),
})

/** 助手消息开始：一次 provider turn 对应一条助手消息。 */
const MessageStarted = z.object({
  ...durableEnvelope,
  type: z.literal("message.started"),
  messageID: z.string(),
  /** 产生这条消息的模型 id */
  model: z.string(),
})

/**
 * 消息中的某个 part 的最终文本。
 *
 * 流式增量（TextDeltaEvent）只用于实时渲染且不落盘，
 * 这个事件才是可重放的权威值：重放时以它为准。
 */
const PartText = z.object({
  ...durableEnvelope,
  type: z.literal("part.text"),
  messageID: z.string(),
  /** part 在消息中的下标 */
  index: z.number().int().nonnegative(),
  text: z.string(),
})

/** 推理过程 part 的最终文本，语义同 PartText。 */
const PartReasoning = z.object({
  ...durableEnvelope,
  type: z.literal("part.reasoning"),
  messageID: z.string(),
  index: z.number().int().nonnegative(),
  text: z.string(),
})

/**
 * 工具调用已被记录。
 *
 * 这个事件必须在工具真正执行之前写入，保证「先落日志再执行」，
 * 否则进程崩溃后无法判断某个副作用是否已经发生。
 */
const ToolCalled = z.object({
  ...durableEnvelope,
  type: z.literal("tool.called"),
  messageID: z.string(),
  index: z.number().int().nonnegative(),
  callID: z.string(),
  name: z.string(),
  input: z.unknown(),
})

/** 工具调用结束并写入最终结果（成功或失败）。 */
const ToolSettled = z.object({
  ...durableEnvelope,
  type: z.literal("tool.settled"),
  callID: z.string(),
  status: z.enum(["success", "error"]),
  /** 结构化结果，成功时存在 */
  output: z.unknown().optional(),
  /** 发给模型的内容块，成功时存在 */
  content: z.array(Content).optional(),
  /** 完整输出的落盘路径，仅在输出超限时存在 */
  outputPaths: z.array(z.string()).optional(),
  /** 错误说明，失败时存在 */
  error: z.string().optional(),
  /** 副作用、修改文件、验证结果与失败分类等结构化语义 */
  metadata: ToolMetadata.optional(),
})

/** 助手消息结束，携带本轮用量与结束原因。 */
const MessageEnded = z.object({
  ...durableEnvelope,
  type: z.literal("message.ended"),
  messageID: z.string(),
  /**
   * 结束原因。常见取值：
   * - `stop` / `length` / `tool_calls`：provider 给出的正常结束原因
   * - `interrupted`：用户中断
   * - `declined`：用户拒绝了授权请求
   * - `error`：本轮失败
   */
  finish: z.string(),
  /** provider 未返回 usage 时为空 */
  usage: Usage.optional(),
  /** 本轮失败时的错误说明。它是给用户看的，不会重新发回模型。 */
  error: z.string().optional(),
})

/** compaction（压缩）完成：旧历史被这条 checkpoint（检查点）消息替代。 */
const CompactionEnded = z.object({
  ...durableEnvelope,
  type: z.literal("compaction.ended"),
  messageID: z.string(),
  text: z.string(),
  /** 执行 compaction 时原样保留的最近消息 id，按原顺序排列 */
  recentMessageIDs: z.array(z.string()),
  reason: z.enum(["automatic", "overflow", "manual", "fallback"]).optional(),
  beforeTokens: z.number().int().nonnegative().optional(),
  afterTokens: z.number().int().nonnegative().optional(),
  attempts: z.number().int().positive().optional(),
  usedFallback: z.boolean().optional(),
})

/**
 * 上下文更新：某个动态来源（例如日期）发生变化时追加的系统消息。
 *
 * 当前实现先追加该事件，随后由 SystemContextManager 单独覆盖写入
 * context.json。两步写入不是原子的，事件本身也不携带 context snapshot（快照）。
 */
const ContextUpdated = z.object({
  ...durableEnvelope,
  type: z.literal("context.updated"),
  messageID: z.string(),
  text: z.string(),
})

/** 产生了一次待审批的权限请求。 */
const PermissionAsked = z.object({
  ...durableEnvelope,
  type: z.literal("permission.asked"),
  requestID: z.string(),
  callID: z.string(),
  action: z.string(),
  resources: z.array(z.string()),
  save: z.array(z.string()),
})

/** 用户回应了某个审批请求。 */
const PermissionReplied = z.object({
  ...durableEnvelope,
  type: z.literal("permission.replied"),
  requestID: z.string(),
  reply: PermissionReply,
  /** 拒绝时用户给出的原因；当前实现会结束当前回合，并保留在工具结果事件中 */
  feedback: z.string().optional(),
})

/**
 * 回合开始。
 *
 * 一个「回合」指从用户输入被唤醒到整个执行流程彻底空闲的完整过程，
 * 它可能包含多次 provider turn。界面必须能准确判断这个状态：
 * 否则会出现「模型正在跑工具，但界面上停止按钮消失了」这类问题。
 *
 * 只从消息状态推导是不够的——两次 provider turn 之间，上一条助手消息
 * 已经结束、下一条还没开始，推导出来会短暂地变成「空闲」。
 */
const RunStarted = z.object({
  ...durableEnvelope,
  type: z.literal("run.started"),
})

/** 回合彻底空闲：所有工具调用均已写入最终结果，也没有待处理的输入了。 */
const RunIdle = z.object({
  ...durableEnvelope,
  type: z.literal("run.idle"),
})

/** 回合被中断。 */
const RunInterrupted = z.object({
  ...durableEnvelope,
  type: z.literal("run.interrupted"),
})

/**
 * 持久化事件联合类型。
 *
 * 这里只导出联合类型而不逐个导出成员 schema：消费方几乎总是
 * 「读取整条日志 → 按 type 收窄 → 处理」，用联合类型即可，
 * 逐个导出反而会让 schema 包的表面积失控。
 */
export const DurableEvent = z.discriminatedUnion("type", [
  SessionCreated,
  SessionUpdated,
  SessionFailed,
  SessionTodos,
  TaskUpdated,
  InputAdmitted,
  InputPromoted,
  MessageStarted,
  PartText,
  PartReasoning,
  ToolCalled,
  ToolSettled,
  MessageEnded,
  CompactionEnded,
  ContextUpdated,
  PermissionAsked,
  PermissionReplied,
  RunStarted,
  RunIdle,
  RunInterrupted,
])

export type DurableEvent = z.infer<typeof DurableEvent>

/**
 * 流式事件联合类型。
 *
 * 它们只在内存中推送、不落盘，断线不补。UI 用它们做实时渲染，
 * 一旦收到对应的持久化事件（例如 part.text），就用权威值整体替换。
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("text.delta"),
    messageID: z.string(),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    ...envelope,
    type: z.literal("reasoning.delta"),
    messageID: z.string(),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    ...envelope,
    type: z.literal("tool.input.delta"),
    callID: z.string(),
    text: z.string(),
  }),
])

export type LiveEvent = z.infer<typeof LiveEvent>

/** 所有事件的联合类型，SSE 推送的都是这个形态。 */
export const Event = z.union([DurableEvent, LiveEvent])

export type Event = z.infer<typeof Event>

/** 判断一个事件是否为持久化事件（依据是带不带 seq）。 */
export const isDurableEvent = (event: Event): event is DurableEvent => "seq" in event
