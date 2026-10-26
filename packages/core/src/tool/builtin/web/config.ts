import { createLogger } from "../../../log.js"
import {
  WEB_PROVIDER_IDS,
  type WebCapabilityConfig,
  type WebProviderID,
  type WebToolConfig,
} from "./types.js"

const logger = createLogger("tool.web.config")

const ENDPOINTS: Record<WebProviderID, string> = {
  deepseek: "https://api.deepseek.com",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  tavily: "https://api.tavily.com",
}

/** 搜索与抓取各自仅在 Provider 和 API Key 同时存在时启用。 */
export const readWebToolConfig = (): WebToolConfig | undefined => {
  const search = readCapability(
    "EASYCODE_WEB_SEARCH_PROVIDER",
    "EASYCODE_WEB_SEARCH_API_KEY",
  )
  const fetch = readCapability(
    "EASYCODE_WEB_FETCH_PROVIDER",
    "EASYCODE_WEB_FETCH_API_KEY",
  )
  if (!search && !fetch) return undefined

  return {
    ...(search ? { search } : {}),
    ...(fetch ? { fetch } : {}),
    timeoutMs: clamp(readEnv("EASYCODE_WEB_TIMEOUT_MS", 30_000), 120_000, "EASYCODE_WEB_TIMEOUT_MS"),
    maxResponseBytes: clamp(
      readEnv("EASYCODE_WEB_MAX_RESPONSE_BYTES", 8 * 1024 * 1024),
      32 * 1024 * 1024,
      "EASYCODE_WEB_MAX_RESPONSE_BYTES",
    ),
    userAgent: process.env.EASYCODE_WEB_USER_AGENT?.trim() || "EasyCode/0.1",
  }
}

const readCapability = (
  providerEnv: string,
  apiKeyEnv: string,
): WebCapabilityConfig | undefined => {
  const apiKey = process.env[apiKeyEnv]?.trim()
  if (!apiKey) return undefined

  const rawProvider = process.env[providerEnv]?.trim().toLowerCase()
  if (!rawProvider) return undefined
  if (!isProviderID(rawProvider)) {
    throw new Error(`${providerEnv} 不合法：${rawProvider}。可选值为 ${WEB_PROVIDER_IDS.join(" / ")}`)
  }

  return {
    provider: rawProvider,
    apiKey,
    baseURL: ENDPOINTS[rawProvider],
  }
}

const isProviderID = (value: string): value is WebProviderID =>
  (WEB_PROVIDER_IDS as readonly string[]).includes(value)

const readEnv = (key: string, fallback: number): number => {
  const raw = process.env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`${key} 必须是正整数，使用默认值`, { value: raw, fallback })
    return fallback
  }
  return value
}

const clamp = (value: number, maximum: number, key: string): number => {
  if (value <= maximum) return value
  logger.warn(`${key} 超过上限，已限制为 ${maximum}`, { value })
  return maximum
}
