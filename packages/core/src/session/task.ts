import type {
  TaskContract,
  TaskKind,
  TaskOutcome,
  TaskOutcomeStatus,
  TaskPhase,
  TaskState,
  VerificationRecord,
} from "@easycode/schema"

/**
 * 从用户输入建立一个轻量任务契约。
 *
 * 这里不做额外的模型调用，也不试图精确理解所有意图。它只提供一个稳定的
 * 工作记忆骨架，模型仍可通过后续工具和最终回复补充细节。
 */
export const createTaskState = (input: string, timestamp: number): TaskState => ({
  version: 1,
  contract: inferTaskContract(input),
  phase: "investigate",
  changedPaths: [],
  verificationStatus: "unknown",
  verifications: [],
  toolCalls: 0,
  repeatedToolCalls: 0,
  mutationRevision: 0,
})

export const inferTaskContract = (input: string): TaskContract => {
  const text = input.trim()
  const kind = inferTaskKind(text)

  return {
    goal: text,
    kind,
    acceptance: acceptanceFor(kind),
    constraints: ["只做完成任务所必需的工作，保留用户已有修改。"],
  }
}

const inferTaskKind = (text: string): TaskKind => {
  const normalized = text.toLowerCase()
  if (/(修复|bug|报错|失败|错误|fix|repair)/i.test(normalized)) return "fix"
  if (/(验证|测试|检查|typecheck|build|lint|test)/i.test(normalized)) return "verify"
  if (/(调查|分析|定位|查找|研究|investigate|analyze|explore)/i.test(normalized)) return "investigate"
  if (/(解释|说明|回答|是什么|为什么|怎么|how|what|why)/i.test(normalized)) return "answer"
  return "implement"
}

const acceptanceFor = (kind: TaskKind): string[] => {
  switch (kind) {
    case "answer":
      return ["直接回答用户问题，并说明仍存在的不确定信息。"]
    case "investigate":
      return ["给出有代码或工具结果支撑的调查结论。"]
    case "verify":
      return ["执行相关验证并明确说明通过、失败或无法验证。"]
    case "fix":
      return ["定位问题并完成必要修改。", "在修改后执行相关验证。"]
    case "implement":
      return ["完成用户要求的功能。", "在修改后执行项目可用的验证。"]
  }
}

export const amendTask = (task: TaskState, input: string): TaskState => ({
  ...task,
  contract: {
    ...task.contract,
    goal: `${task.contract.goal}\n\n用户补充：${input.trim()}`,
  },
  phase: task.changedPaths.length > 0 ? "execute" : "investigate",
})

export const moveTaskPhase = (task: TaskState, phase: TaskPhase): TaskState =>
  task.phase === phase ? task : { ...task, phase }

export const recordVerification = (task: TaskState, verification: VerificationRecord): TaskState => {
  const verifications = [...task.verifications, verification].slice(-20)
  return {
    ...task,
    phase: verification.status === "failed" ? "verify" : "finalize",
    verificationStatus: verification.status,
    verifications,
  }
}

export const renderTaskState = (task: TaskState): string => {
  const lines = [
    "<task-state>",
    `阶段：${task.phase}`,
    `目标：${task.contract.goal}`,
    `任务类型：${task.contract.kind}`,
    "验收条件：",
    ...task.contract.acceptance.map((item) => `- ${item}`),
    "约束：",
    ...task.contract.constraints.map((item) => `- ${item}`),
    `修改文件：${task.changedPaths.length > 0 ? task.changedPaths.join("、") : "无"}`,
    `验证状态：${task.verificationStatus}`,
  ]

  if (task.verifications.length > 0) {
    lines.push("最近验证：")
    for (const verification of task.verifications.slice(-4)) {
      lines.push(
        `- ${verification.status}: ${verification.summary}${verification.command ? `（${verification.command}）` : ""}`,
      )
    }
  }

  if (task.lastObservation) lines.push(`最近观察：${task.lastObservation}`)
  if (task.repeatedToolCalls > 0) {
    lines.push(`重复工具调用：${task.repeatedToolCalls} 次；若没有新信息，请更换策略或说明阻塞。`)
  }
  if (task.verificationStatus === "stale") {
    lines.push("代码已经修改但验证尚未完成。结束任务前应执行相关验证，或明确说明无法验证的原因。")
  }
  if (task.outcome) lines.push(`任务结果：${task.outcome.status}，${task.outcome.summary}`)
  lines.push("</task-state>")
  return lines.join("\n")
}

export const finishTask = (
  task: TaskState,
  input: {
    status: TaskOutcomeStatus
    summary: string
    remaining?: string[]
    timestamp: number
  },
): TaskState => {
  const outcome: TaskOutcome = {
    status: input.status,
    summary: input.summary,
    completed: [],
    remaining: input.remaining ?? [],
    changedPaths: [...task.changedPaths],
    verifications: [...task.verifications],
    timestamp: input.timestamp,
  }
  return {
    ...task,
    phase: input.status === "success" ? "finalize" : input.status === "blocked" ? "blocked" : task.phase,
    outcome,
  }
}

export const taskMemorySummary = (task: TaskState | undefined): string => {
  if (!task) return "无"
  return [
    `目标：${task.contract.goal}`,
    `阶段：${task.phase}`,
    `修改文件：${task.changedPaths.join("、") || "无"}`,
    `验证状态：${task.verificationStatus}`,
    ...task.verifications.slice(-3).map((item) => `验证：${item.status} ${item.summary}`),
    ...(task.lastObservation ? [`最近观察：${task.lastObservation}`] : []),
  ].join("\n")
}
