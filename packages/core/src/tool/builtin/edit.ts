import { readFile, stat, writeFile } from "node:fs/promises"
import { z } from "zod"

import { ToolFailure } from "../../errors.js"
import { ensureWithinWorkspace, resolveToolPath } from "../paths.js"
import { defineTool } from "../tool.js"

/**
 * 精确字符串替换。
 *
 * 这是 agent 修改代码的主力工具，因此容错信息必须写得足够好——
 * 模型改不动文件时最需要知道的就是「为什么没匹配上」。
 *
 * 几个刻意的行为：
 * - 匹配是严格的字符串匹配，不做模糊、不做正则。模糊匹配看起来更聪明，
 *   但它会在模型给出错误上下文时改到不该改的地方，代价远大于收益。
 * - 出现多次且未指定 replaceAll 时直接失败，让模型补充上下文，
 *   而不是猜「它大概想改第一处」。
 * - 写入前校验文件是否被外部改动过，避免覆盖掉用户刚在编辑器里的修改。
 */

const inputSchema = z.object({
  path: z.string().describe("要修改的文件路径，相对路径以工作目录为基准"),
  oldString: z.string().describe("要被替换的原文，必须与文件内容完全一致（包括缩进、空行、标点）"),
  newString: z.string().describe("替换后的新内容，传空字符串表示删除该段内容"),
  replaceAll: z.boolean().optional().describe("原文出现多次时是否全部替换，默认只替换出现一次的情况"),
})

type Input = z.infer<typeof inputSchema>

export const editTool = defineTool({
  name: "edit",
  description: [
    "对文件做精确的字符串替换。这是修改已有文件的首选方式。",
    "要求：",
    "- oldString 必须与文件内容**完全一致**，包括缩进和换行。通常先用 read 工具读取确认。",
    "- 如果 oldString 在文件中出现多次，需要提供更多上下文让它唯一，或者设置 replaceAll=true。",
    "- 不涉及修改的行请保持原样，不要顺手调整格式。",
    "整体重写文件请使用 write 工具。",
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

    if (input.oldString.length === 0) {
      throw new ToolFailure("oldString 不能为空。如果要整体重写文件，请使用 write 工具。", {
        kind: "invalid_input",
      })
    }
    if (input.oldString === input.newString) {
      throw new ToolFailure("新内容与原文完全相同，不需要修改。", { kind: "invalid_input" })
    }

    const before = await stat(target.absolute).catch(() => undefined)
    if (!before?.isFile())
      throw new ToolFailure(`文件不存在或不是普通文件：${target.display}`, { kind: "not_found" })

    const original = await readFile(target.absolute, "utf8")
    const occurrences = countOccurrences(original, input.oldString)

    if (occurrences === 0) {
      throw new ToolFailure(
        `在 ${target.display} 中找不到要替换的内容。请先用 read 工具确认原文，` +
          `注意缩进、空行和标点必须与文件完全一致。`,
        { kind: "invalid_input" },
      )
    }

    if (occurrences > 1 && input.replaceAll !== true) {
      throw new ToolFailure(
        `原文在 ${target.display} 中出现了 ${occurrences} 次，无法确定要替换哪一处。` +
          `请提供更多上下文让原文唯一，或设置 replaceAll=true 替换全部 ${occurrences} 处。`,
        { kind: "invalid_input" },
      )
    }

    const updated =
      input.replaceAll === true
        ? original.split(input.oldString).join(input.newString)
        : original.replace(input.oldString, input.newString)

    // 并发保护：如果文件在读入之后被其它程序改过，这里的 mtime 或大小会变，
    // 此时继续写入会覆盖掉别人的修改
    const current = await stat(target.absolute).catch(() => undefined)
    if (!current || current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
      throw new ToolFailure(`${target.display} 在读取之后被其它程序修改过，请重新用 read 读取后再修改。`, {
        kind: "transient",
        retryable: true,
      })
    }

    await writeFile(target.absolute, updated, "utf8")

    const change = summarizeChange(original, updated)
    context.logger.info("已修改文件", {
      path: target.display,
      occurrences: input.replaceAll === true ? occurrences : 1,
      added: change.added,
      removed: change.removed,
    })

    return {
      output: {
        path: target.display,
        replaced: input.replaceAll === true ? occurrences : 1,
        startLine: change.startLine,
        added: change.added,
        removed: change.removed,
      },
      content: [
        {
          type: "text",
          text:
            `已修改 ${target.display}：第 ${change.startLine} 行起，` +
            `替换 ${input.replaceAll === true ? occurrences : 1} 处（+${change.added} 行 / -${change.removed} 行）`,
        },
      ],
      metadata: { effect: "mutation", changedPaths: [target.display] },
    }
  },
})

/** 统计子串出现次数。 */
const countOccurrences = (text: string, search: string): number => {
  if (search.length === 0) return 0
  return text.split(search).length - 1
}

/**
 * 计算改动的规模。
 *
 * 用「公共前缀 + 公共后缀」的方式定位改动范围：比逐行 diff 简单得多，
 * 但对「替换一小段」这种最常见的场景足够准确，也符合本产品不做 diff 视图的定位。
 */
const summarizeChange = (before: string, after: string): { startLine: number; added: number; removed: number } => {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")

  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    startLine: prefix + 1,
    removed: beforeLines.length - prefix - suffix,
    added: afterLines.length - prefix - suffix,
  }
}

export type { Input }
