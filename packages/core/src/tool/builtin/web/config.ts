import { createLogger } from "../../../log.js"
import type {
  CoreWebConfig,
  WebCapabilityConfig,
  WebProviderID,
  WebToolConfig,
} from "./types.js"

const logger = createLogger("tool.web.config")

const ENDPOINTS: Record<WebProviderID, string> = {
  deepseek: "https://api.deepseek.com",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  tavily: "https://api.tavily.com",
}

/** 把已验证的 Core 配置转换成联网工具运行参数。 */
export const resolveWebToolConfig = (config: CoreWebConfig): WebToolConfig | undefined => {
  const search = resolveCapability("search", config.search)
  const fetch = resolveCapability("fetch", config.fetch)
  if (!search && !fetch) return undefined

  return {
    ...(search ? { search } : {}),
    ...(fetch ? { fetch } : {}),
    timeoutMs: config.timeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    userAgent: config.userAgent || "EasyCode/0.1",
  }
}

const resolveCapability = (
  kind: "search" | "fetch",
  capability: CoreWebConfig["search"],
): WebCapabilityConfig | undefined => {
  if (!capability.provider || capability.apiKey.length === 0) return undefined
  logger.debug("联网能力已启用", { kind, provider: capability.provider })
  return {
    provider: capability.provider,
    apiKey: capability.apiKey,
    baseURL: ENDPOINTS[capability.provider],
  }
}
