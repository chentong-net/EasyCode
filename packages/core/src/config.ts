import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { parse, stringify } from "smol-toml"
import { z } from "zod"

import type { LLMClientConfig } from "./llm/types.js"
import { createLogger, setLogLevel, type LogLevel } from "./log.js"
import { WEB_PROVIDER_IDS, type CoreWebConfig, type WebProviderID } from "./tool/builtin/web/types.js"
import { expandHome } from "./util/path.js"

const logger = createLogger("config")

/** 用户可见的固定 EasyCode 根目录，不再允许通过环境变量修改。 */
export const EASYCODE_HOME_DIR = resolve(expandHome("~/easycode"))
/** 应用内部状态目录：会话、工具输出、日志与配置文件都在这里。 */
export const EASYCODE_STATE_DIR = join(EASYCODE_HOME_DIR, ".easycode")
/** 唯一的应用运行配置文件。 */
export const EASYCODE_CONFIG_FILE = join(EASYCODE_STATE_DIR, "config.toml")

export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192
export const DEFAULT_WEB_TIMEOUT_MS = 30_000
export const DEFAULT_WEB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export interface StoredRuntimeConfig {
  baseUrl: string
  apiKey: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  temperature?: number
  headers: Record<string, string>
  web: CoreWebConfig
  logLevel: LogLevel
}

/** Core 的完整运行配置。除进程通信参数外，不允许环境变量参与配置。 */
export interface CoreConfig extends StoredRuntimeConfig {
  /** 固定配置文件路径。 */
  configFile: string
  /** 固定内部状态目录。 */
  dataDir: string
  /** 是否已经具备发起模型请求所需的最小配置。 */
  modelConfigured: boolean
}

const Provider = z.enum(WEB_PROVIDER_IDS)

const WebCapabilityFile = z
  .object({
    provider: Provider.optional(),
    api_key: z.string().default(""),
  })
  .default({})

const ConfigFile = z
  .object({
    model: z
      .object({
        base_url: z.string().url().default(DEFAULT_BASE_URL),
        api_key: z.string().default(""),
        name: z.string().default(""),
        context_window: z.number().int().positive().default(DEFAULT_CONTEXT_WINDOW),
        max_output_tokens: z.number().int().positive().default(DEFAULT_MAX_OUTPUT_TOKENS),
        temperature: z.number().finite().optional(),
        headers: z.record(z.string(), z.string()).default({}),
      })
      .default({}),
    web: z
      .object({
        timeout_ms: z.number().int().positive().max(120_000).default(DEFAULT_WEB_TIMEOUT_MS),
        max_response_bytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024)
          .default(DEFAULT_WEB_MAX_RESPONSE_BYTES),
        search: WebCapabilityFile,
        fetch: WebCapabilityFile,
      })
      .default({}),
    runtime: z
      .object({
        log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      })
      .default({}),
  })
  .default({})

type ConfigFile = z.infer<typeof ConfigFile>

/**
 * 加载固定路径上的 config.toml。
 *
 * 文件不存在时会创建一份默认配置；配置不合法时直接报错，避免静默使用
 * 一半旧值、一半默认值。模型凭据缺失不会阻止 Core 启动，桌面端仍能打开设置页。
 */
export const loadCoreConfig = (): CoreConfig => {
  ensureConfigFile()
  const stored = readStoredRuntimeConfig(EASYCODE_CONFIG_FILE)
  setLogLevel(stored.logLevel)

  const config: CoreConfig = {
    ...stored,
    configFile: EASYCODE_CONFIG_FILE,
    dataDir: EASYCODE_STATE_DIR,
    modelConfigured: stored.apiKey.length > 0 && stored.model.length > 0,
  }

  logger.info("配置加载完成", {
    configFile: config.configFile,
    dataDir: config.dataDir,
    baseUrl: config.baseUrl,
    model: config.model,
    modelConfigured: config.modelConfigured,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    hasTemperature: config.temperature !== undefined,
    extraHeaderCount: Object.keys(config.headers).length,
    logLevel: config.logLevel,
    webSearchEnabled: webCapabilityEnabled(config.web.search),
    webFetchEnabled: webCapabilityEnabled(config.web.fetch),
  })

  return config
}

export const readStoredRuntimeConfig = (file: string): StoredRuntimeConfig => {
  let raw: unknown
  try {
    raw = parse(readFileSync(file, "utf8"))
  } catch (error) {
    throw new Error(`无法解析配置文件：${file}`, { cause: error })
  }

  const parsed = ConfigFile.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`配置文件结构不符合预期：${file}\n${parsed.error.message}`)
  }
  return fromConfigFile(parsed.data)
}

export const renderStoredRuntimeConfig = (config: StoredRuntimeConfig): string => {
  const model: Record<string, unknown> = {
    base_url: config.baseUrl,
    api_key: config.apiKey,
    name: config.model,
    context_window: config.contextWindow,
    max_output_tokens: config.maxOutputTokens,
  }
  if (config.temperature !== undefined) model.temperature = config.temperature
  if (Object.keys(config.headers).length > 0) model.headers = config.headers

  const web: Record<string, unknown> = {
    timeout_ms: config.web.timeoutMs,
    max_response_bytes: config.web.maxResponseBytes,
  }
  const search = capabilityToFile(config.web.search)
  const fetch = capabilityToFile(config.web.fetch)
  if (search !== undefined) web.search = search
  if (fetch !== undefined) web.fetch = fetch

  const content = stringify({
    model,
    web,
    runtime: { log_level: config.logLevel },
  })

  return [
    "# EasyCode 运行配置",
    "# 配置文件固定为 ~/easycode/.easycode/config.toml",
    "# 密钥仅保存在本机；环境变量不会覆盖这些值。",
    "",
    content.trimEnd(),
    "",
  ].join("\n")
}

/** 从配置中取出 LLM 客户端需要的连接信息。 */
export const toLLMClientConfig = (config: CoreConfig): LLMClientConfig => ({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
})

/** 判断内部状态目录是否已经存在。 */
export const dataDirExists = (config: CoreConfig): boolean => existsSync(config.dataDir)

const ensureConfigFile = (): void => {
  mkdirSync(dirname(EASYCODE_CONFIG_FILE), { recursive: true })
  if (!existsSync(EASYCODE_CONFIG_FILE)) {
    writeFileSync(
      EASYCODE_CONFIG_FILE,
      renderStoredRuntimeConfig(defaultStoredConfig()),
      { encoding: "utf8", mode: 0o600 },
    )
  }
  chmodSync(EASYCODE_CONFIG_FILE, 0o600)
}

const defaultStoredConfig = (): StoredRuntimeConfig => ({
  baseUrl: DEFAULT_BASE_URL,
  apiKey: "",
  model: "",
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  headers: {},
  web: {
    timeoutMs: DEFAULT_WEB_TIMEOUT_MS,
    maxResponseBytes: DEFAULT_WEB_MAX_RESPONSE_BYTES,
    search: { apiKey: "" },
    fetch: { apiKey: "" },
  },
  logLevel: "info",
})

const fromConfigFile = (config: ConfigFile): StoredRuntimeConfig => ({
  baseUrl: config.model.base_url,
  apiKey: config.model.api_key,
  model: config.model.name,
  contextWindow: config.model.context_window,
  maxOutputTokens: config.model.max_output_tokens,
  ...(config.model.temperature === undefined ? {} : { temperature: config.model.temperature }),
  headers: config.model.headers,
  web: {
    timeoutMs: config.web.timeout_ms,
    maxResponseBytes: config.web.max_response_bytes,
    search: {
      ...(config.web.search.provider === undefined ? {} : { provider: config.web.search.provider }),
      apiKey: config.web.search.api_key,
    },
    fetch: {
      ...(config.web.fetch.provider === undefined ? {} : { provider: config.web.fetch.provider }),
      apiKey: config.web.fetch.api_key,
    },
  },
  logLevel: config.runtime.log_level,
})

const capabilityToFile = (
  capability: CoreWebConfig["search"],
): { provider?: WebProviderID; api_key: string } | undefined => {
  if (capability.provider === undefined && capability.apiKey.length === 0) return undefined
  return {
    ...(capability.provider === undefined ? {} : { provider: capability.provider }),
    api_key: capability.apiKey,
  }
}

const webCapabilityEnabled = (capability: CoreWebConfig["search"]): boolean =>
  capability.provider !== undefined && capability.apiKey.length > 0
