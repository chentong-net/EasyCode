import { z } from "zod"

import { Usage } from "./usage.js"

/**
 * 待办事项的状态。
 *
 * 同一时刻只应该有一项处于 in_progress —— 这是靠提示词约束的，
 * 不在代码里强制，因为模型偶尔会同时展开两项，为此报错反而更烦人。
 */
export const TodoStatus = z.enum(["pending", "in_progress", "completed"])

export type TodoStatus = z.infer<typeof TodoStatus>

/** 一条待办事项。 */
export const Todo = z.object({
  /** 待办内容，一句话描述要做什么 */
  content: z.string(),
  status: TodoStatus,
})

export type Todo = z.infer<typeof Todo>

/**
 * 一个会话。
 *
 * 会话与工作目录是强绑定的：在 EasyCode 里，用户先选定一个工作目录，
 * 然后在该目录下创建对话。`model` 在会话创建时确定，会话内不再变化。
 */
export const Session = z.object({
  id: z.string(),
  /** 会话标题：创建时可通过请求指定，否则由首条输入截断生成；当前没有修改标题的 API */
  title: z.string(),
  /** 绑定的工作目录绝对路径 */
  directory: z.string(),
  /** 当前使用的 agent，首版只有 build */
  agent: z.string(),
  /** 当前使用的模型 id */
  model: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 置顶时间；未置顶时为空。 */
  pinnedAt: z.number().int().positive().optional(),
  /** 会话级累计用量，用于 UI 展示 */
  usage: Usage,
  /** 当前的任务清单，由 todowrite 工具维护 */
  todos: z.array(Todo).default([]),
})

export type Session = z.infer<typeof Session>
