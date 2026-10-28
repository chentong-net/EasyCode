import { z } from "zod"

/**
 * 用户管理的本地工作区。
 *
 * `directory` 是 Agent 的实际操作边界，`name` 只是可重命名的展示名称。
 * 两者分开保存，重命名工作区不会改变会话的历史目录，也不会重命名磁盘目录。
 */
export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  /** 工作区根目录的绝对路径。 */
  directory: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** 置顶时间；未置顶时为空。默认工作区不依赖该字段，始终固定排在第一位。 */
  pinnedAt: z.number().int().positive().optional(),
})

export type Workspace = z.infer<typeof Workspace>
