import { z } from "zod"

import { Usage } from "./usage.js"

/**
 * 一个会话。
 *
 * 会话与工作目录是强绑定的：在 EasyCode 里，用户先选定一个工作目录，
 * 然后在该目录下创建对话。`model` 在会话创建时确定，会话内不再变化。
 */
export const Session = z.object({
  id: z.string(),
  /** 会话标题，创建时由首条输入截断生成，用户可后续修改 */
  title: z.string(),
  /** 绑定的工作目录绝对路径 */
  directory: z.string(),
  /** 当前使用的 agent，首版只有 build */
  agent: z.string(),
  /** 当前使用的模型 id */
  model: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 会话级累计用量，用于 UI 展示 */
  usage: Usage,
})

export type Session = z.infer<typeof Session>
