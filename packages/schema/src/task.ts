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

/** compaction（压缩）和后续回合都必须保留的任务契约。 */
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

/** 显式任务预算，供 Runner 和界面判断是否接近或耗尽执行上限。 */
export const TaskBudget = z.object({
  softSteps: z.number().int().positive(),
  hardSteps: z.number().int().positive(),
  /** 当前续行窗口的检查点间隔。 */
  checkpointSteps: z.number().int().positive().default(30),
  /** 当前回合累计经过的 provider turn，跨检查点继续累加。 */
  totalSteps: z.number().int().nonnegative().default(0),
  usedSteps: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  extensions: z.number().int().nonnegative(),
})

export type TaskBudget = z.infer<typeof TaskBudget>

/**
 * 可重放的任务工作记忆。它独立于聊天消息存在，执行 compaction（压缩）时不会随摘要丢失。
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
  /** 待办清单实际发生内容或状态变化时递增。 */
  todoRevision: z.number().int().nonnegative().default(0),
  /** 最近一次真实待办更新发生时的累计工具调用序号。 */
  lastTodoUpdateToolCall: z.number().int().nonnegative().default(0),
  /** 已经针对哪个待办版本发出过停滞提醒。 */
  todoReminderRevision: z.number().int().nonnegative().optional(),
  mutationRevision: z.number().int().nonnegative(),
  lastToolSignature: z.string().optional(),
  lastObservation: z.string().optional(),
  verificationNudgedRevision: z.number().int().nonnegative().optional(),
  budget: TaskBudget.default({
    softSteps: 20,
    hardSteps: 30,
    checkpointSteps: 30,
    totalSteps: 0,
    usedSteps: 0,
    exhausted: false,
    extensions: 0,
  }),
  outcome: TaskOutcome.optional(),
})

export type TaskState = z.infer<typeof TaskState>
