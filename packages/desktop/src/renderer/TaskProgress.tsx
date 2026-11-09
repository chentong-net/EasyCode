import type { TaskPhase, TaskState, Todo } from "@easycode/schema"
import { Check, ChevronDown, ChevronRight, Circle, ListChecks, LoaderCircle } from "lucide-react"
import { useState } from "react"

const PHASE_LABELS: Record<TaskPhase, string> = {
  clarify: "澄清需求",
  investigate: "调查代码",
  plan: "整理计划",
  execute: "执行修改",
  verify: "运行验证",
  finalize: "收尾总结",
  blocked: "遇到阻塞",
}

const VERIFICATION_LABELS = {
  unknown: "未验证",
  stale: "待重新验证",
  passed: "验证通过",
  failed: "验证失败",
} as const

const OUTCOME_LABELS = {
  success: "已完成",
  partial: "部分完成",
  blocked: "已阻塞",
  cancelled: "已取消",
} as const

export const TaskProgress = ({
  task,
  todos,
  running,
}: {
  task: TaskState | undefined
  todos: Todo[]
  running: boolean
}) => {
  const [expanded, setExpanded] = useState(true)
  if (task === undefined) return null

  const outcome = task.outcome
  const tone = outcome?.status ?? (task.phase === "blocked" ? "blocked" : "active")
  const completedTodos = todos.filter((todo) => todo.status === "completed").length
  const latestVerification = task.verifications.at(-1)
  const visiblePaths = task.changedPaths.slice(0, 5)

  return (
    <section className={`task-progress task-progress-${tone}`} aria-label="任务进度">
      <button
        type="button"
        className="task-progress-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <ListChecks size={15} strokeWidth={1.8} className="task-progress-icon" />
        <span className="task-progress-title">任务进度</span>
        <span className="task-progress-phase">{PHASE_LABELS[task.phase]}</span>
        <span className="task-progress-spacer" />
        {todos.length > 0 && (
          <span className="task-progress-count">
            {completedTodos}/{todos.length}
          </span>
        )}
        <span className="task-progress-steps">
          {task.budget.usedSteps}/{task.budget.checkpointSteps}
        </span>
        {expanded ? (
          <ChevronDown size={15} strokeWidth={1.8} className="task-progress-chevron" />
        ) : (
          <ChevronRight size={15} strokeWidth={1.8} className="task-progress-chevron" />
        )}
      </button>

      {expanded && (
        <div className="task-progress-body">
          <p className="task-progress-goal">{task.contract.goal}</p>

          {todos.length > 0 && (
            <ol className="task-todo-list">
              {todos.map((todo, index) => (
                <li className={`task-todo task-todo-${todo.status}`} key={`${index}-${todo.content}`}>
                  <TodoMarker status={todo.status} />
                  <span>{todo.content}</span>
                </li>
              ))}
            </ol>
          )}

          <div className="task-progress-meta">
            <span>
              修改文件 <strong>{task.changedPaths.length}</strong>
            </span>
            <span className={`task-verification task-verification-${task.verificationStatus}`}>
              {VERIFICATION_LABELS[task.verificationStatus]}
            </span>
            <span>
              累计步骤 <strong>{task.budget.totalSteps}</strong>
            </span>
            {running && !outcome && (
              <span className="task-live">
                <LoaderCircle size={12} strokeWidth={2} />
                进行中
              </span>
            )}
            {outcome && <span className="task-outcome">{OUTCOME_LABELS[outcome.status]}</span>}
          </div>

          {visiblePaths.length > 0 && (
            <div className="task-paths">
              {visiblePaths.map((path) => (
                <code key={path}>{path}</code>
              ))}
              {task.changedPaths.length > visiblePaths.length && (
                <span>另有 {task.changedPaths.length - visiblePaths.length} 个文件</span>
              )}
            </div>
          )}

          {latestVerification !== undefined && (
            <p className={`task-verification-summary task-verification-${latestVerification.status}`}>
              最近验证：{latestVerification.summary}
            </p>
          )}

          {outcome !== undefined && outcome.remaining.length > 0 && (
            <p className="task-remaining">{outcome.remaining.join("；")}</p>
          )}
        </div>
      )}
    </section>
  )
}

const TodoMarker = ({ status }: { status: Todo["status"] }) => {
  if (status === "completed") return <Check size={14} strokeWidth={2.2} />
  if (status === "in_progress") return <LoaderCircle size={14} strokeWidth={2} className="task-todo-spinner" />
  return <Circle size={13} strokeWidth={1.8} />
}
