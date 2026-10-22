import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"

import { writeFileAtomic } from "../../util/atomic.js"
import { ensureWithinWorkspace, resolveToolPath } from "../paths.js"
import { defineTool } from "../tool.js"
import { formatBytes } from "./read.js"

/**
 * 写入文件（整体覆盖或新建）。
 *
 * 与 edit 的分工要清楚：write 用于新建文件或整体重写，edit 用于局部替换。
 * 这一点必须写进工具描述里，否则模型会习惯性地用 write 覆盖整个文件，
 * 把用户其它未提及的改动一起冲掉。
 */

const inputSchema = z.object({
  path: z.string().describe("要写入的文件路径，相对路径以工作目录为基准"),
  content: z.string().describe("文件的完整内容。注意这是整体覆盖，不是追加"),
})

type Input = z.infer<typeof inputSchema>

export const writeTool = defineTool({
  name: "write",
  description: [
    "写入文件。文件已存在时会整体覆盖，不存在时新建（会自动创建父目录）。",
    "只做局部修改时请使用 edit 工具：write 会覆盖掉文件里其它未被提及的内容。",
    "新建文件时必须用这个工具，不要用 bash 的 echo/cat 重定向。",
  ].join("\n"),
  input: inputSchema,
  permission: "edit",
  effect: "mutation",
  resources: (input) => [input.path],
  savePatterns: (input) => [input.path],
  execute: async (input, context) => {
    const target = resolveToolPath(context.directory, input.path)
    await ensureWithinWorkspace(target, context)
    await context.authorize({ action: "edit", resources: [target.display] })

    const existed = await fileExists(target.absolute)
    await mkdir(dirname(target.absolute), { recursive: true })
    await writeFileAtomic(target.absolute, input.content)

    const bytes = Buffer.byteLength(input.content, "utf8")
    const lines = input.content.split("\n").length

    context.logger.info("已写入文件", { path: target.display, bytes, existed })

    return {
      output: { path: target.display, bytes, lines, created: !existed },
      content: [
        {
          type: "text",
          text: `${existed ? "已覆盖" : "已创建"}文件：${target.display}（${lines} 行，${formatBytes(bytes)}）`,
        },
      ],
      metadata: { effect: "mutation", changedPaths: [target.display] },
    }
  },
})

/** 判断文件是否已存在。用 stat 而不是 access，因为需要区分「不存在」与「无权限」。 */
const fileExists = async (absolute: string): Promise<boolean> => {
  try {
    await stat(absolute)
    return true
  } catch {
    return false
  }
}
