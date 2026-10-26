export const WEB_PROVIDER_IDS = ["deepseek", "glm", "tavily"] as const

export type WebProviderID = (typeof WEB_PROVIDER_IDS)[number]

export interface WebCapabilityConfig {
  provider: WebProviderID
  apiKey: string
  baseURL: string
}

export interface WebToolConfig {
  search?: WebCapabilityConfig
  fetch?: WebCapabilityConfig
  timeoutMs: number
  maxResponseBytes: number
  userAgent: string
}

export interface WebSearchInput {
  query: string
  limit?: number
}

export interface WebSearchResult {
  title?: string
  url: string
  snippet?: string
  summary?: string
  content?: string
  publishedAt?: string
  siteName?: string
  siteIconUrl?: string
  score?: number
  authority?: number
  citationRef?: string
}

export interface WebSearchResponse {
  provider: WebProviderID
  query: string
  results: WebSearchResult[]
  rewrittenQuery?: string
  searchIntent?: string[]
}

export interface WebFetchResult {
  provider: WebProviderID
  requestedUrl: string
  finalUrl?: string
  title?: string
  content: string
  format: "markdown" | "text"
}

export interface WebSearchService {
  readonly provider: WebProviderID
  search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchResponse>
}

export interface WebFetchService {
  readonly provider: WebProviderID
  fetch(url: string, signal: AbortSignal): Promise<WebFetchResult>
}
