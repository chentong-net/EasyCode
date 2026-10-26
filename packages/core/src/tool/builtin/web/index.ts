import { createLogger } from "../../../log.js"
import type { Tool } from "../../tool.js"
import { readWebToolConfig } from "./config.js"
import { createFetchService, createSearchService } from "./providers.js"
import { createWebFetchTool } from "./webfetch.js"
import { createWebSearchTool } from "./websearch.js"

/** 根据环境配置返回当前可用的搜索与抓取工具。 */
export const createWebTools = (): Tool<unknown>[] => {
  const config = readWebToolConfig()
  if (!config) return []

  const logger = createLogger("tool.web")
  const tools: Tool<unknown>[] = []
  if (config.search) {
    tools.push(createWebSearchTool(createSearchService(config.search, config, logger)))
  }
  if (config.fetch) {
    tools.push(createWebFetchTool(createFetchService(config.fetch, config, logger)))
  }
  return tools
}
