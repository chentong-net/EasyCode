import type { Tool } from "../tool.js"
import { bashTool } from "./bash.js"
import { editTool } from "./edit.js"
import { globTool } from "./glob.js"
import { grepTool } from "./grep.js"
import { questionTool } from "./question.js"
import { readTool } from "./read.js"
import { todoWriteTool } from "./todowrite.js"
import { createWebTools } from "./web/index.js"
import { writeTool } from "./write.js"

/**
 * 内置工具清单。
 *
 * 基础工具覆盖「看代码 → 找代码 → 改代码 → 跑验证 → 管进度 → 必要澄清」。
 * 搜索和抓取只在配置完整时加入。
 *
 * 工具的顺序会影响它们在请求里的排列顺序，这里按「先读后写」的直觉排列：
 * read / glob / grep 在前，edit / write / bash 在后。
 */
export const createBuiltinTools = (): Tool<unknown>[] => {
  const tools: Tool<unknown>[] = [readTool, globTool, grepTool, ...createWebTools()]
  tools.push(editTool, writeTool, bashTool, questionTool, todoWriteTool)
  return tools
}

export { bashTool, editTool, globTool, grepTool, questionTool, readTool, todoWriteTool, writeTool }
