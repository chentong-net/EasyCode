import { relative, join } from "node:path"
import { glob } from "glob"
import { z } from "zod"

import { ensureWithinWorkspace, resolveToolPath } from "../paths.js"
import { defineTool } from "../tool.js"

/**
 * 按文件名模式查找文件。
 *
 * 实现上直接使用 glob 库而不是自己遍历目录：glob 模式语义（尤其是 `**`
 * 的层级处理）细节很多，自己实现几乎必然与用户预期不一致。
 *
 * 默认排除 node_modules、.git 等目录。这不是「优化」，而是必要行为：
 * 在任何一个真实项目里，不排除依赖目录的搜索结果都是噪音。
 */

const MAX_RESULTS = 200

/** 默认排除的目录。依赖目录与构建产物对 agent 几乎没有价值。 */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/.cache/**",
  // EasyCode 自己的数据目录。会话日志里存着模型看到过的全部内容，
  // 被 agent 检索到既是纯粹的噪音，也可能把敏感信息重新喂回上下文
  "**/.easycode/**",
]

const inputSchema = z.object({
  pattern: z.string().describe("glob 模式，例如 **/*.ts、src/**/*.tsx、**/package.json"),
  path: z.string().optional().describe("搜索的起始目录，默认为会话工作目录"),
})

type Input = z.infer<typeof inputSchema>

export const globTool = defineTool({
  name: "glob",
  description: [
    "按文件名模式查找文件，返回按名称排序的路径列表。",
    `最多返回 ${MAX_RESULTS} 条结果，超出会提示截断。`,
    "node_modules、.git、dist、build 等目录默认被排除。",
    "在不知道文件具体位置时，用这个工具定位文件比逐个目录 read 更高效。",
  ].join("\n"),
  input: inputSchema,
  effect: "read",
  resources: (input) => [input.pattern],
  savePatterns: (input) => [input.pattern],
  execute: async (input, context) => {
    const searchRoot = input.path ? resolveToolPath(context.directory, input.path) : undefined
    if (searchRoot) await ensureWithinWorkspace(searchRoot, context)
    await context.authorize({ action: "glob", resources: [input.pattern] })

    const cwd = searchRoot?.absolute ?? context.directory
    const matches = await glob(input.pattern, {
      cwd,
      ignore: DEFAULT_IGNORE,
      nodir: false,
      dot: false,
      follow: false,
      absolute: false,
    })

    const sorted = matches.sort((a, b) => a.localeCompare(b))
    const shown = sorted.slice(0, MAX_RESULTS)

    // 结果统一转换为「相对会话工作目录」的路径，这样无论搜索起点在哪，
    // 模型拿到的路径都能直接喂给 read / edit
    const prefix = searchRoot ? relative(context.directory, searchRoot.absolute) : ""
    const display = shown.map((match) => (prefix.length > 0 ? join(prefix, match) : match))

    context.logger.info("glob 查找完成", { pattern: input.pattern, matched: sorted.length, shown: shown.length })

    if (sorted.length === 0) {
      return {
        output: { pattern: input.pattern, matches: [], total: 0 },
        content: [{ type: "text", text: `没有找到匹配 ${input.pattern} 的文件。` }],
        metadata: { effect: "read" },
      }
    }

    const footer = sorted.length > shown.length ? `\n...（共 ${sorted.length} 条，另有 ${sorted.length - shown.length} 条未显示）` : ""

    return {
      output: { pattern: input.pattern, matches: display, total: sorted.length },
      content: [
        {
          type: "text",
          text: `匹配 ${input.pattern} 的文件共 ${sorted.length} 个：\n${display.join("\n")}${footer}`,
        },
      ],
      metadata: { effect: "read" },
    }
  },
})

export type { Input }
