import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import type { CoreConfig } from "./config.js"
import { expandHome } from "./util/path.js"

export const WEB_PROVIDER_IDS = ["deepseek", "glm", "tavily"] as const
export type WebProviderID = (typeof WEB_PROVIDER_IDS)[number]
export type RuntimeLogLevel = "debug" | "info" | "warn" | "error"

/**
 * 配置界面的安全视图。
 *
 * API Key 等敏感值只返回“是否已配置”，不把明文送进渲染进程。用户留空
 * 密钥输入框时表示保持原值；显式清除则通过 update 中的 null 表达。
 */
export interface RuntimeConfigView {
  envFile: string
  baseUrl: string
  model: string
  modelConfigured: boolean
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  hasApiKey: boolean
  hasExtraHeaders: boolean
  webSearchProvider?: WebProviderID
  hasWebSearchApiKey: boolean
  webFetchProvider?: WebProviderID
  hasWebFetchApiKey: boolean
  dataDir: string
  logLevel: RuntimeLogLevel
}

export interface RuntimeConfigUpdate {
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number | null
  /** undefined 表示保持原值，null 表示清除。 */
  apiKey?: string | null
  extraHeaders?: string | null
  webSearchProvider: WebProviderID | ""
  webSearchApiKey?: string | null
  webFetchProvider: WebProviderID | ""
  webFetchApiKey?: string | null
  dataDir: string
  logLevel: RuntimeLogLevel
}

export interface ConfigurationService {
  read(): Promise<RuntimeConfigView>
  update(input: RuntimeConfigUpdate): Promise<RuntimeConfigView>
}

interface ConfigurationDeps {
  config: CoreConfig
}

const ENV_KEYS = {
  baseUrl: "OPENAI_BASE_URL",
  apiKey: "OPENAI_API_KEY",
  model: "OPENAI_MODEL",
  contextWindow: "OPENAI_MODEL_CONTEXT_WINDOW",
  maxOutputTokens: "OPENAI_MAX_OUTPUT_TOKENS",
  temperature: "OPENAI_TEMPERATURE",
  extraHeaders: "OPENAI_EXTRA_HEADERS",
  webSearchProvider: "EASYCODE_WEB_SEARCH_PROVIDER",
  webSearchApiKey: "EASYCODE_WEB_SEARCH_API_KEY",
  webFetchProvider: "EASYCODE_WEB_FETCH_PROVIDER",
  webFetchApiKey: "EASYCODE_WEB_FETCH_API_KEY",
  dataDir: "EASYCODE_DATA_DIR",
  logLevel: "EASYCODE_LOG_LEVEL",
} as const

export const createConfigurationService = (deps: ConfigurationDeps): ConfigurationService => {
  let current = readInitialView(deps.config)
  let writes = Promise.resolve()

  const read = async (): Promise<RuntimeConfigView> => ({ ...current })

  const update = (input: RuntimeConfigUpdate): Promise<RuntimeConfigView> => {
    const operation = writes.then(async () => {
      const next = normalizeUpdate(input)
      await updateEnvFile(deps.config.envFile, next)
      current = applyUpdate(current, next)
      return { ...current }
    })
    writes = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  return { read, update }
}

const readInitialView = (config: CoreConfig): RuntimeConfigView => {
  const webSearchProvider = readProvider("EASYCODE_WEB_SEARCH_PROVIDER")
  const webFetchProvider = readProvider("EASYCODE_WEB_FETCH_PROVIDER")
  const rawTemperature = readEnv("OPENAI_TEMPERATURE")
  const temperature = rawTemperature === undefined ? undefined : Number(rawTemperature)

  return {
    envFile: config.envFile,
    baseUrl: config.baseUrl,
    model: config.model,
    modelConfigured: config.modelConfigured,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    ...(temperature !== undefined && Number.isFinite(temperature) ? { temperature } : {}),
    hasApiKey: config.apiKey.length > 0,
    hasExtraHeaders: (readEnv("OPENAI_EXTRA_HEADERS")?.length ?? 0) > 0,
    ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
    hasWebSearchApiKey: (readEnv("EASYCODE_WEB_SEARCH_API_KEY")?.length ?? 0) > 0,
    ...(webFetchProvider === undefined ? {} : { webFetchProvider }),
    hasWebFetchApiKey: (readEnv("EASYCODE_WEB_FETCH_API_KEY")?.length ?? 0) > 0,
    dataDir: config.dataDir,
    logLevel: readLogLevel(),
  }
}

const normalizeUpdate = (input: RuntimeConfigUpdate): RuntimeConfigUpdate => ({
  baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
  model: input.model.trim(),
  contextWindow: input.contextWindow,
  maxOutputTokens: input.maxOutputTokens,
  temperature: input.temperature === null ? null : input.temperature,
  apiKey: normalizeSecret(input.apiKey),
  extraHeaders: normalizeSecret(input.extraHeaders),
  webSearchProvider: input.webSearchProvider,
  webSearchApiKey: normalizeSecret(input.webSearchApiKey),
  webFetchProvider: input.webFetchProvider,
  webFetchApiKey: normalizeSecret(input.webFetchApiKey),
  dataDir: resolve(expandHome(input.dataDir.trim())),
  logLevel: input.logLevel,
})

const normalizeSecret = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) return value
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const applyUpdate = (current: RuntimeConfigView, input: RuntimeConfigUpdate): RuntimeConfigView => {
  const hasApiKey = input.apiKey === undefined ? current.hasApiKey : input.apiKey !== null
  const hasWebSearchApiKey =
    input.webSearchApiKey === undefined ? current.hasWebSearchApiKey : input.webSearchApiKey !== null
  const hasWebFetchApiKey =
    input.webFetchApiKey === undefined ? current.hasWebFetchApiKey : input.webFetchApiKey !== null
  const temperature = input.temperature === null ? undefined : (input.temperature ?? current.temperature)
  const webSearchProvider = input.webSearchProvider === "" ? undefined : input.webSearchProvider
  const webFetchProvider = input.webFetchProvider === "" ? undefined : input.webFetchProvider

  return {
    envFile: current.envFile,
    baseUrl: input.baseUrl,
    model: input.model,
    modelConfigured: hasApiKey && input.model.length > 0,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    ...(temperature === undefined ? {} : { temperature }),
    hasApiKey,
    hasExtraHeaders:
      input.extraHeaders === undefined ? current.hasExtraHeaders : input.extraHeaders !== null,
    ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
    hasWebSearchApiKey,
    ...(webFetchProvider === undefined ? {} : { webFetchProvider }),
    hasWebFetchApiKey,
    dataDir: input.dataDir,
    logLevel: input.logLevel,
  }
}

const updateEnvFile = async (file: string, input: RuntimeConfigUpdate): Promise<void> => {
  let original = ""
  try {
    original = await readFile(file, "utf8")
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  const updates = new Map<string, string | null>([
    [ENV_KEYS.baseUrl, input.baseUrl],
    [ENV_KEYS.model, input.model],
    [ENV_KEYS.contextWindow, String(input.contextWindow)],
    [ENV_KEYS.maxOutputTokens, String(input.maxOutputTokens)],
    [ENV_KEYS.dataDir, input.dataDir],
    [ENV_KEYS.logLevel, input.logLevel],
    [ENV_KEYS.webSearchProvider, input.webSearchProvider || null],
    [ENV_KEYS.webFetchProvider, input.webFetchProvider || null],
  ])

  if (input.temperature !== undefined) {
    updates.set(ENV_KEYS.temperature, input.temperature === null ? null : String(input.temperature))
  }
  addOptionalUpdate(updates, ENV_KEYS.apiKey, input.apiKey)
  addOptionalUpdate(updates, ENV_KEYS.extraHeaders, input.extraHeaders)
  addOptionalUpdate(updates, ENV_KEYS.webSearchApiKey, input.webSearchApiKey)
  addOptionalUpdate(updates, ENV_KEYS.webFetchApiKey, input.webFetchApiKey)

  const seen = new Set<string>()
  const lines = original.split(/\r?\n/)
  const rendered: string[] = []
  for (const line of lines) {
    const key = envKeyOf(line)
    if (key === undefined || !updates.has(key)) {
      rendered.push(line)
      continue
    }
    seen.add(key)
    const value = updates.get(key)
    if (value !== null && value !== undefined) rendered.push(`${key}=${serializeEnvValue(value)}`)
  }

  for (const [key, value] of updates) {
    if (seen.has(key) || value === null || value === undefined) continue
    rendered.push(`${key}=${serializeEnvValue(value)}`)
  }

  const content = `${trimTrailingEmptyLines(rendered).join("\n")}\n`
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

const addOptionalUpdate = (
  updates: Map<string, string | null>,
  key: string,
  value: string | null | undefined,
): void => {
  if (value !== undefined) updates.set(key, value)
}

const envKeyOf = (line: string): string | undefined =>
  line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]

const serializeEnvValue = (value: string): string => {
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value
  if (!value.includes('"')) return `"${value}"`
  if (!value.includes("'")) return `'${value}'`
  throw new Error("配置值同时包含单引号和双引号，无法安全写入 .env")
}

const trimTrailingEmptyLines = (lines: string[]): string[] => {
  const result = [...lines]
  while (result.length > 0 && (result.at(-1) ?? "").trim().length === 0) result.pop()
  return result
}

const readProvider = (key: string): WebProviderID | undefined => {
  const value = readEnv(key)?.toLowerCase()
  return WEB_PROVIDER_IDS.includes(value as WebProviderID) ? (value as WebProviderID) : undefined
}

const readLogLevel = (): RuntimeLogLevel => {
  const value = readEnv("EASYCODE_LOG_LEVEL")?.toLowerCase()
  return value === "debug" || value === "warn" || value === "error" ? value : "info"
}

const readEnv = (key: string): string | undefined => {
  const value = process.env[key]?.trim()
  return value && value.length > 0 ? value : undefined
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
