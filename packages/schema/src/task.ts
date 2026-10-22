import { z } from "zod"

/**
 * 任务类型决定 Runner 对完成条件的基本判断，不直接改变工具权限。
 */
export const TaskKind = z.enum(["answer", "investigate", "implement", "fix", "verify"])

export type TaskKind = z.infer<typeof TaskKind>

/**
 * 一个回合内的显式阶段。模型无法直接修改阶段，Runner 根据工具结果和结束条件推进。
 */
export const TaskPhase = z.enum([
  "clarify",
  "investigate",
  "plan",
  "execute",
  "verify",
  "finalize",
  "blocked",
])

export type TaskPhase = z.infer<typeof TaskPhase>

export const VerificationStatus = z.enum(["unknown", "stale", "passed", "failed"])

export type VerificationStatus = z.infer<typeof VerificationStatus>

export const VerificationResult = z.enum(["passed", "failed", "unknown"])

export type VerificationResult = z.infer<typeof VerificationResult>

/** 一次验证命令的结构化证据，避免模型只能从自由文本猜测是否通过。 */
export const VerificationRecord = z.object({
  command: z.string().optional(),
  status: VerificationResult,
  summary: z.string(),
  callID: z.string().optional(),
  timestamp: z.number(),
})

export type VerificationRecord = z.infer<typeof VerificationRecord>

/** 压缩和后续回合都必须保留的任务契约。 */
export const TaskContract = z.object({
  goal: z.string(),
  kind: TaskKind,
  acceptance: z.array(z.string()),
  constraints: z.array(z.string()),
})

export type TaskContract = z.infer<typeof TaskContract>

export const TaskOutcomeStatus = z.enum(["success", "partial", "blocked", "cancelled"])

export type TaskOutcomeStatus = z.infer<typeof TaskOutcomeStatus>

/** 任务结束时给用户和后续上下文使用的稳定结果，而不是从自然语言回复中猜测。 */
export const TaskOutcome = z.object({
  status: TaskOutcomeStatus,
  summary: z.string(),
  completed: z.array(z.string()),
  remaining: z.array(z.string()),
  changedPaths: z.array(z.string()),
  verifications: z.array(VerificationRecord),
  timestamp: z.number(),
})

export type TaskOutcome = z.infer<typeof TaskOutcome>

/**
 * 可重放的任务工作记忆。它独立于聊天消息存在，压缩历史时不会随摘要丢失。
 */
export const TaskState = z.object({
  version: z.literal(1),
  contract: TaskContract,
  phase: TaskPhase,
  changedPaths: z.array(z.string()),
  verificationStatus: VerificationStatus,
  verifications: z.array(VerificationRecord).max(20),
  toolCalls: z.number().int().nonnegative(),
  repeatedToolCalls: z.number().int().nonnegative(),
  lastToolSignature: z.string().optional(),
  lastObservation: z.string().optional(),
  verificationNudgedRevision: z.number().int().nonnegative().optional(),
  outcome: TaskOutcome.optional(),
})

export type TaskState = z.infer<typeof TaskState>
