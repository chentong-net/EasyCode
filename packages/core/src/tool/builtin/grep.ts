import { readFile, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { glob } from "glob"
import { z } from "zod"

import { ToolFailure } from "../../errors.js"
import { ensureWithinWorkspace, resolveToolPath, type ResolvedPath } from "../paths.js"
import { defineTool } from "../tool.js"
import { DEFAULT_IGNORE } from "./glob.js"

/**
 * 在文件内容中检索。
 *
 * 为什么不用 ripgrep：那需要引入平台相关的二进制产物，安装时会带来
 * 「下载失败导致装不上」这类与产品无关的问题。这里的实现是纯 JS 遍历 + 正则，
 * 配合目录排除与体积上限，在中小型项目上够用，而且行为完全可预期。
 *
 * 三个必要的防护：跳过依赖目录、跳过超大文件、跳过二进制文件。
 * 缺任何一个都会出现「一次检索把上下文撑爆」或「卡在一个 500MB 的日志文件上」。
 */

/** 单次最多返回的匹配数 */
const MAX_MATCHES = 200
/** 单个文件的最大读取体积，超过则跳过（通常是压缩产物或数据文件） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 单条匹配结果的文本上限，避免单行就是整个文件的情况 */
const MAX_MATCH_LENGTH = 400
/** 遍历的最大目录深度，防止符号链接造成的无限递归 */
const MAX_DEPTH = 24

const inputSchema = z.object({
  pattern: z.string().describe("要检索的正则表达式，例如 function\\s+handleLogin"),
  path: z.string().optional().describe("检索的目录或文件，默认为会话工作目录"),
  include: z.string().optional().describe("只检索匹配该 glob 的文件，例如 *.ts 或 src/**/*.tsx"),
  ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认区分大小写"),
})

type Input = z.infer<typeof inputSchema>

interface Match {
  path: string
  line: number
  text: string
}

export const grepTool = defineTool({
  name: "grep",
  description: [
    "在文件内容中按正则表达式检索，返回匹配的文件、行号与该行内容。",
    `最多返回 ${MAX_MATCHES} 处匹配。`,
    "node_modules、.git、dist 等目录默认被排除；二进制文件与超过 2MB 的文件会被跳过。",
    "需要按文件名查找请使用 glob 工具。",
  ].join("\n"),
  input: inputSchema,
  effect: "read",
  resources: (input) => [input.pattern],
  savePatterns: (input) => [input.pattern],
  execute: async (input, context) => {
    let regexp: RegExp
    try {
      regexp = new RegExp(input.pattern, input.ignoreCase === true ? "i" : "")
    } catch (error) {
      throw new ToolFailure(`正则表达式不合法：${error instanceof Error ? error.message : String(error)}`)
    }

    // 要求模式不能匹配空字符串，否则每一行都会命中，结果毫无意义
    if (regexp.test("")) {
      throw new ToolFailure("正则表达式可以匹配空字符串，会产生大量无意义结果。请提供更具体的模式。")
    }

    const target = input.path ? resolveToolPath(context.directory, input.path) : undefined
    if (target) await ensureWithinWorkspace(target, context)
    await context.authorize({ action: "grep", resources: [input.pattern] })

    const { files, displayOf } = await collectCandidates(target, input.include, context.directory)

    const matches: Match[] = []
    let scanned = 0
    let truncated = false

    for (const file of files) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true
        break
      }
      scanned += 1
      const found = await scanFile(file, displayOf(file), regexp, MAX_MATCHES - matches.length)
      matches.push(...found)
    }

    context.logger.info("grep 检索完成", {
      pattern: input.pattern,
      scannedFiles: scanned,
      matches: matches.length,
      truncated,
    })

    return {
      output: {
        pattern: input.pattern,
        matches,
        scanned,
        matchedFiles: new Set(matches.map((match) => match.path)).size,
        truncated,
      },
      content: [{ type: "text", text: renderMatches(input.pattern, matches, scanned, truncated) }],
      metadata: { effect: "read" },
    }
  },
})

/**
 * 枚举待检索的文件，并给出每个文件用于展示的路径。
 *
 * `path` 既可以指向目录，也可以指向单个文件。指向文件时**不能**走 glob：
 * glob 的 cwd 必须是目录，拿一个文件当 cwd 只会得到零个候选文件，
 * 于是「文件里明明有这段内容」也会被报告成没有匹配。这种静默的假否定
 * 比报错更有害：模型会据此认定检索工具坏了，转而用别的方式绕，
 * 甚至得出「文件里没有这段内容」这种错误的结论。
 */
const collectCandidates = async (
  target: ResolvedPath | undefined,
  include: string | undefined,
  directory: string,
): Promise<{ files: string[]; displayOf: (absolute: string) => string }> => {
  if (target === undefined) {
    return { files: await collectFiles(directory, include), displayOf: (absolute) => relative(directory, absolute) }
  }

  const info = await stat(target.absolute).catch(() => undefined)
  // 路径不存在时必须明说：报「没有匹配」会让模型以为检索过了
  if (info === undefined) throw new ToolFailure(`路径不存在：${target.display}`)

  // 指向单个文件时忽略 include：范围已经被缩小到一个文件了
  if (info.isFile()) return { files: [target.absolute], displayOf: () => target.display }

  return {
    files: await collectFiles(target.absolute, include),
    displayOf: (absolute) => relative(target.absolute, absolute),
  }
}

/**
 * 枚举候选文件。
 *
 * 用 glob 而不是手写目录遍历：这样 `include` 的语义与 glob 工具完全一致，
 * 而且排除规则可以复用同一份清单。`nodir` 为 true 保证结果里只有文件。
 */
const collectFiles = async (root: string, include: string | undefined): Promise<string[]> => {
  const pattern = include ? `**/${include.replace(/^\.\//, "")}` : "**/*"
  const matches = await glob(pattern, {
    cwd: root,
    ignore: DEFAULT_IGNORE,
    nodir: true,
    dot: false,
    follow: false,
    absolute: true,
  })
  return matches.sort((a, b) => a.localeCompare(b))
}

/** 检索单个文件，返回匹配行。读取或解码失败时静默跳过。 */
const scanFile = async (absolute: string, display: string, regexp: RegExp, budget: number): Promise<Match[]> => {
  const info = await stat(absolute).catch(() => undefined)
  if (!info?.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return []

  const buffer = await readFile(absolute).catch(() => undefined)
  if (!buffer) return []
  // 二进制文件（含 NUL 字节）一律跳过
  if (buffer.subarray(0, 8192).includes(0)) return []

  const matches: Match[] = []

  const lines = buffer.toString("utf8").split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    if (matches.length >= budget) break
    const line = lines[index] ?? ""
    if (!regexp.test(line)) continue
    matches.push({
      path: display,
      line: index + 1,
      text: line.length > MAX_MATCH_LENGTH ? `${line.slice(0, MAX_MATCH_LENGTH)}...` : line.trim(),
    })
  }

  return matches
}

/** 把匹配结果渲染成按文件分组、带行号的文本。 */
const renderMatches = (pattern: string, matches: Match[], scanned: number, truncated: boolean): string => {
  if (matches.length === 0) {
    return `在 ${scanned} 个文件中没有找到匹配 ${pattern} 的内容。`
  }

  const grouped = new Map<string, Match[]>()
  for (const match of matches) {
    const list = grouped.get(match.path) ?? []
    list.push(match)
    grouped.set(match.path, list)
  }

  const blocks = [...grouped.entries()].map(
    ([path, list]) => `${path}:\n${list.map((match) => `  ${match.line}: ${match.text}`).join("\n")}`,
  )

  const header = `匹配 ${pattern} 的结果：${grouped.size} 个文件，共 ${matches.length} 处${
    truncated ? `（已达 ${MAX_MATCHES} 处上限，结果被截断）` : ""
  }`

  return `${header}\n\n${blocks.join("\n\n")}`
}

export { MAX_MATCHES }
export type { Input }
