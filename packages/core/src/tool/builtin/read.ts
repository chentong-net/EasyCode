import { readFile, readdir, stat } from "node:fs/promises"
import { extname } from "node:path"
import { z } from "zod"

import { ToolFailure } from "../../errors.js"
import { ensureWithinWorkspace, resolveToolPath } from "../paths.js"
import { defineTool, type ToolContext, type ToolResult } from "../tool.js"

/**
 * 读取文件或目录。
 *
 * 三条硬约束：
 * 1. 单次最多返回 2000 行、单行最多 2000 字符。模型不会因为一次拿到 10 万行
 *    就理解得更好，只会把上下文塞满。
 * 2. 二进制文件直接拒绝，不做猜测。把二进制当文本读出来会产生一堆乱码，
 *    而且极耗 token。
 * 3. 图片以内容块形式返回（base64），模型可以真正「看到」截图。
 */

const DEFAULT_LIMIT = 2_000
const MAX_LINE_LENGTH = 2_000
/** 超过这个体积的文件直接拒绝读取，避免一次读入上百 MB */
const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 图片体积上限，base64 之后体积会膨胀约三分之一 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** 列目录时最多返回的条目数 */
const MAX_DIRECTORY_ENTRIES = 500

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

const inputSchema = z.object({
  path: z.string().describe("要读取的文件或目录路径，相对路径以工作目录为基准"),
  offset: z.number().int().positive().optional().describe("起始行号（从 1 开始）。读取大文件的后半段时使用"),
  limit: z.number().int().positive().optional().describe(`最多读取的行数，默认 ${DEFAULT_LIMIT}`),
})

type Input = z.infer<typeof inputSchema>

export const readTool = defineTool({
  name: "read",
  description: [
    "读取文件内容或列出目录内容。",
    "返回的每一行都带有行号，格式为「行号 + Tab + 内容」。",
    `单次最多返回 ${DEFAULT_LIMIT} 行，超出部分需要用 offset 参数继续读取。`,
    "路径可以是相对工作目录的相对路径，也可以是绝对路径；访问工作目录之外的路径会先征求用户同意。",
    "图片文件会作为图像内容返回，可以直接查看。",
  ].join("\n"),
  input: inputSchema,
  effect: "read",
  resources: (input) => [input.path],
  // 记住「总是允许读这个文件」是有风险且没什么价值的，保持每次询问
  savePatterns: () => [],
  execute: async (input, context) => {
    const target = resolveToolPath(context.directory, input.path)
    await ensureWithinWorkspace(target, context)
    await context.authorize({ action: "read", resources: [target.display] })

    let info
    try {
      info = await stat(target.absolute)
    } catch {
      throw new ToolFailure(`路径不存在：${target.display}`, { kind: "not_found" })
    }

    if (info.isDirectory()) return listDirectory(target.absolute, target.display, input)

    if (info.size > MAX_FILE_BYTES) {
      throw new ToolFailure(
        `文件过大（${formatBytes(info.size)}），超过 ${formatBytes(MAX_FILE_BYTES)} 的读取上限。请改用 grep 检索其中的内容。`,
        { kind: "invalid_input" },
      )
    }

    const mime = IMAGE_MIME[extname(target.absolute).toLowerCase()]
    if (mime) return readImage(target.absolute, target.display, mime, info.size)

    return readTextFile(target.absolute, target.display, input)
  },
})

/** 列出目录内容。按名称排序，目录以 `/` 结尾以便与文件区分。 */
const listDirectory = async (absolute: string, display: string, input: Input): Promise<ToolResult> => {
  const entries = await readdir(absolute, { withFileTypes: true })
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const shown = sorted.slice(0, MAX_DIRECTORY_ENTRIES)

  const lines = shown.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  const header = `${display}/（共 ${sorted.length} 项）`
  const footer =
    sorted.length > shown.length ? `\n...（还有 ${sorted.length - shown.length} 项未显示）` : ""

  return {
    output: { kind: "directory", path: display, total: sorted.length, entries: lines },
    content: [{ type: "text", text: `${header}\n${lines.join("\n")}${footer}` }],
    metadata: { effect: "read" },
  }
}

/** 读取图片，作为内容块返回。 */
const readImage = async (absolute: string, display: string, mime: string, size: number): Promise<ToolResult> => {
  if (size > MAX_IMAGE_BYTES) {
    throw new ToolFailure(`图片过大（${formatBytes(size)}），超过 ${formatBytes(MAX_IMAGE_BYTES)} 的上限`)
  }

  const data = (await readFile(absolute)).toString("base64")
  return {
    output: { kind: "image", path: display, mime, bytes: size },
    content: [
      { type: "text", text: `已读取图片：${display}（${mime}，${formatBytes(size)}）` },
      { type: "file", mime, data, name: display },
    ],
    metadata: { effect: "read" },
  }
}

/** 读取文本文件，带行号与分页。 */
const readTextFile = async (absolute: string, display: string, input: Input): Promise<ToolResult> => {
  const buffer = await readFile(absolute)
  if (looksBinary(buffer)) {
    throw new ToolFailure(`文件看起来是二进制内容，无法按文本读取：${display}`, { kind: "invalid_input" })
  }

  const allLines = buffer.toString("utf8").split("\n")
  const offset = Math.max((input.offset ?? 1) - 1, 0)
  const limit = input.limit ?? DEFAULT_LIMIT

  if (offset >= allLines.length) {
    throw new ToolFailure(
      `起始行号 ${offset + 1} 超出文件范围（共 ${allLines.length} 行）：${display}`,
      { kind: "invalid_input" },
    )
  }

  const selected = allLines.slice(offset, offset + limit)
  const numberWidth = String(offset + selected.length).length

  const rendered = selected.map((line, index) => {
    const lineNumber = String(offset + index + 1).padStart(numberWidth)
    const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...（本行过长已截断）` : line
    return `${lineNumber}\t${text}`
  })

  const remaining = allLines.length - (offset + selected.length)
  const header = `${display}（共 ${allLines.length} 行，显示第 ${offset + 1}-${offset + selected.length} 行）`
  const footer = remaining > 0 ? `\n...（还有 ${remaining} 行，可用 offset=${offset + selected.length + 1} 继续读取）` : ""

  return {
    output: {
      kind: "file",
      path: display,
      totalLines: allLines.length,
      startLine: offset + 1,
      endLine: offset + selected.length,
    },
    content: [{ type: "text", text: `${header}\n${rendered.join("\n")}${footer}` }],
    metadata: { effect: "read" },
  }
}

/**
 * 判断是否为二进制内容。
 *
 * 只看开头若干字节里有没有 NUL 字节：文本文件几乎不会出现 NUL，
 * 而绝大多数二进制格式在头部就会出现。这比按扩展名判断可靠得多
 * （扩展名可能缺失或写错）。
 */
const looksBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8192).includes(0)

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
