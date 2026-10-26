import { ToolFailure } from "../../../errors.js"
import type { Logger } from "../../../log.js"
import { postJSON } from "./http.js"
import type {
  WebCapabilityConfig,
  WebFetchResult,
  WebFetchService,
  WebSearchInput,
  WebSearchResponse,
  WebSearchResult,
  WebSearchService,
  WebToolConfig,
} from "./types.js"

interface ProviderOptions {
  capability: WebCapabilityConfig
  timeoutMs: number
  maxResponseBytes: number
  userAgent: string
  logger: Logger
}

type RuntimeConfig = Omit<WebToolConfig, "search" | "fetch">

export const createSearchService = (
  capability: WebCapabilityConfig,
  config: RuntimeConfig,
  logger: Logger,
): WebSearchService => ({
  provider: capability.provider,
  search: (input, signal) => {
    const options = providerOptions(capability, config, logger)
    switch (capability.provider) {
      case "deepseek":
        return searchDeepSeek(options, input, signal)
      case "glm":
        return searchGlm(options, input, signal)
      case "tavily":
        throw new ToolFailure(`${capability.provider} 搜索适配尚未实现`)
    }
  },
})

export const createFetchService = (
  capability: WebCapabilityConfig,
  config: RuntimeConfig,
  logger: Logger,
): WebFetchService => ({
  provider: capability.provider,
  fetch: (url, signal) => {
    const options = providerOptions(capability, config, logger)
    switch (capability.provider) {
      case "deepseek":
        return fetchDeepSeek(options, url, signal)
      case "glm":
        return fetchGlm(options, url, signal)
      case "tavily":
        throw new ToolFailure(`${capability.provider} 抓取适配尚未实现`)
    }
  },
})

const searchDeepSeek = async (
  options: ProviderOptions,
  input: WebSearchInput,
  signal: AbortSignal,
): Promise<WebSearchResponse> => {
  const raw = await request(options, "/v1/tools/search", {
    query: input.query,
    count: input.limit ?? 8,
    need_content: false,
  }, signal)
  const payload = record(raw, "DeepSeek")
  const results = array(payload.results, "DeepSeek", "results").flatMap((value) => {
    const item = record(value, "DeepSeek")
    const url = httpURL(item.url)
    if (!url) return []
    const content = text(item.content)

    return [{
      title: text(item.title),
      url,
      snippet: text(item.snippet),
      summary: text(item.summary),
      content,
      publishedAt: date(item.date),
      siteName: text(item.site_name),
      siteIconUrl: httpURL(item.site_icon),
      score: number(item.rerank_score),
      authority: number(item.authority),
    } satisfies WebSearchResult]
  })

  return {
    provider: "deepseek",
    query: input.query,
    results,
  }
}

const fetchDeepSeek = async (
  options: ProviderOptions,
  url: string,
  signal: AbortSignal,
): Promise<WebFetchResult> => {
  const raw = await request(options, "/v1/tools/fetch", { url }, signal)
  const payload = record(raw, "DeepSeek")
  const content = text(payload.content)
  if (!content) throw new ToolFailure("DeepSeek 未能提取网页正文", { kind: "not_found" })

  return {
    provider: "deepseek",
    requestedUrl: url,
    finalUrl: url,
    title: text(payload.title),
    content,
    format: "markdown",
  }
}

const searchGlm = async (
  options: ProviderOptions,
  input: WebSearchInput,
  signal: AbortSignal,
): Promise<WebSearchResponse> => {
  const raw = await request(options, "/web_search", {
    search_query: input.query,
    search_engine: "search_std",
    search_intent: false,
    count: input.limit ?? 8,
    content_size: "medium",
  }, signal)
  const payload = record(raw, "GLM")
  const results = optionalArray(payload.search_result).flatMap((value) => {
    const item = record(value, "GLM")
    const url = httpURL(item.link)
    if (!url) return []

    return [{
      title: text(item.title),
      url,
      summary: text(item.content),
      publishedAt: date(item.publish_date),
      siteName: text(item.media),
      siteIconUrl: httpURL(item.icon),
      citationRef: text(item.refer),
    } satisfies WebSearchResult]
  })
  const intents = optionalArray(payload.search_intent)
    .map((value) => text(record(value, "GLM").intent))
    .filter((value): value is string => value !== undefined)
  const rewrittenQuery = optionalArray(payload.search_intent)
    .map((value) => text(record(value, "GLM").keywords))
    .find((value) => value !== undefined)

  return {
    provider: "glm",
    query: input.query,
    results,
    ...(rewrittenQuery ? { rewrittenQuery } : {}),
    ...(intents.length > 0 ? { searchIntent: intents } : {}),
  }
}

const fetchGlm = async (
  options: ProviderOptions,
  url: string,
  signal: AbortSignal,
): Promise<WebFetchResult> => {
  const raw = await request(options, "/reader", {
    url,
    return_format: "markdown",
    retain_images: false,
    no_gfm: false,
    keep_img_data_url: false,
    with_images_summary: false,
    with_links_summary: false,
  }, signal)
  const payload = record(raw, "GLM")
  const result = payload.reader_result === undefined
    ? undefined
    : record(payload.reader_result, "GLM")
  const content = result ? text(result.content) : undefined
  if (!result || !content) throw new ToolFailure("GLM 未能提取网页正文", { kind: "not_found" })

  return {
    provider: "glm",
    requestedUrl: url,
    finalUrl: httpURL(result.url) ?? url,
    title: text(result.title),
    content,
    format: "markdown",
  }
}

const request = (
  options: ProviderOptions,
  path: string,
  body: unknown,
  signal: AbortSignal,
) =>
  postJSON({
    provider: options.capability.provider,
    url: joinURL(options.capability.baseURL, path),
    apiKey: options.capability.apiKey,
    body,
    signal,
    timeoutMs: options.timeoutMs,
    maxResponseBytes: options.maxResponseBytes,
    userAgent: options.userAgent,
    logger: options.logger,
  })

const providerOptions = (
  capability: WebCapabilityConfig,
  config: RuntimeConfig,
  logger: Logger,
): ProviderOptions => ({
  capability,
  timeoutMs: config.timeoutMs,
  maxResponseBytes: config.maxResponseBytes,
  userAgent: config.userAgent,
  logger,
})

const record = (value: unknown, provider: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolFailure(`${provider} 返回格式不合法`)
  }
  return value as Record<string, unknown>
}

const array = (value: unknown, provider: string, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new ToolFailure(`${provider} 响应缺少 ${field} 数组`)
  return value
}

const optionalArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  return result || undefined
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const httpURL = (value: unknown): string | undefined => {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const date = (value: unknown): string | undefined => {
  const raw = text(value)
  if (!raw) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

const joinURL = (baseURL: string, path: string): string =>
  `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
