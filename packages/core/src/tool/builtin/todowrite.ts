import { z } from "zod"

import { ToolFailure } from "../../errors.js"
import { defineTool } from "../tool.js"

/**
 * 维护任务清单。
 *
 * 这个工具不产生任何副作用，也不改变文件系统，它的价值在于**迫使模型先规划再动手**。
 * 对多步骤任务来说，「先把要做的事列出来」能显著减少遗漏和反复。
 *
 * 清单是整表覆盖的：模型每次给出完整列表。让它做增量修改（把第 3 项标成完成）
 * 反而更容易出错——它需要先记住当前清单长什么样，而清单恰好在上下文里可能已被 compaction（压缩）。
 */

const inputSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe("要做什么，一句话描述"),
        status: z.enum(["pending", "in_progress", "completed"]).describe("待办状态"),
      }),
    )
    .describe("完整的任务清单，每次都要给出全部条目（整表覆盖）"),
})

type Input = z.infer<typeof inputSchema>

export const todoWriteTool = defineTool({
  name: "todowrite",
  description: [
    "维护当前会话的任务清单，用于规划多步骤任务并跟踪进度。",
    "每次调用都会用新清单整体替换旧清单，因此必须给出全部条目。",
    "同一时刻只应该有一项处于 in_progress。",
    "每完成一项后立即再次调用本工具：把该项改为 completed，并把下一项改为 in_progress。",
    "不要等全部工作结束后才一次性更新所有状态。",
    "只做简单的一两步操作时不需要使用这个工具。",
  ].join("\n"),
  input: inputSchema,
  // 清单是会话内部状态，不涉及外部资源，因此不需要用户授权
  permission: "todowrite",
  effect: "state",
  resources: () => [],
  savePatterns: () => [],
  execute: async (input, context) => {
    const previous = context.session.todos()
    const todos = input.todos.map((todo) => ({ content: todo.content.trim(), status: todo.status }))
    const empty = todos.filter((todo) => todo.content.length === 0)
    if (empty.length > 0) throw new ToolFailure("任务内容不能为空", { kind: "invalid_input" })

    const inProgress = todos.filter((todo) => todo.status === "in_progress").length
    if (inProgress > 1) {
      // 不报错：模型偶尔会同时展开两项，为此中断整个任务不值得。
      // 但要在日志里留下痕迹，便于分析模型行为。
      context.logger.warn("任务清单里有多个进行中的条目", { count: inProgress, total: todos.length })
    }

    await context.session.setTodos(todos)

    const completed = todos.filter((todo) => todo.status === "completed").length
    const changed = !sameTodos(previous, todos)
    context.logger.info("任务清单已更新", { total: todos.length, completed })

    return {
      output: { todos, total: todos.length, completed, changed },
      content: [
        {
          type: "text",
          text: [
            `任务清单已更新（共 ${todos.length} 项，已完成 ${completed} 项）：`,
            renderTodos(todos),
          ].join("\n"),
        },
      ],
      metadata: { effect: "state" },
    }
  },
})

/** 渲染成勾选列表，回显给模型确认它写的清单被正确记录。 */
const renderTodos = (todos: Array<{ content: string; status: string }>): string =>
  todos
    .map((todo) => {
      const marker = todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[~]" : "[ ]"
      return `${marker} ${todo.content}`
    })
    .join("\n")

const sameTodos = (
  left: Array<{ content: string; status: string }>,
  right: Array<{ content: string; status: string }>,
): boolean =>
  left.length === right.length &&
  left.every((todo, index) => todo.content === right[index]?.content && todo.status === right[index]?.status)

export type { Input }
