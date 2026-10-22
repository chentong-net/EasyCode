import type { Tool } from "../tool.js"
import { bashTool } from "./bash.js"
import { editTool } from "./edit.js"
import { globTool } from "./glob.js"
import { grepTool } from "./grep.js"
import { questionTool } from "./question.js"
import { readTool } from "./read.js"
import { todoWriteTool } from "./todowrite.js"
import { writeTool } from "./write.js"

/**
 * 内置工具清单。
 *
 * 首版刻意只保留这八个：它们覆盖了「看代码 → 找代码 → 改代码 → 跑验证 → 管进度 → 必要澄清」
 * 这条完整链路。每多一个工具，模型的工具选择难度就上升一点，
 * 因此像 webfetch / websearch / skill / MCP 这类能力留到确实需要时再加。
 *
 * 工具的顺序会影响它们在请求里的排列顺序，这里按「先读后写」的直觉排列：
 * read / glob / grep 在前，edit / write / bash 在后。
 */
export const createBuiltinTools = (): Tool<unknown>[] => [
  readTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  bashTool,
  questionTool,
  todoWriteTool,
]

export { bashTool, editTool, globTool, grepTool, questionTool, readTool, todoWriteTool, writeTool }
