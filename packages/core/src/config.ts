import { existsSync } from "node:fs"
import { resolve } from "node:path"

import type { LLMClientConfig } from "./llm/types.js"
import { createLogger } from "./log.js"
import { loadEnvFile } from "./env.js"
import { expandHome } from "./util/path.js"

const logger = createLogger("config")

/**
 * Core 的运行配置。
 *
 * 全部来自环境变量（可以由 .env 提供）。这里只做「读取 + 校验 + 给默认值」。
 * 缺少模型凭据时 Core 仍会启动，桌面端才能展示应用内设置页；真正请求模型时
 * 再由 LLM 客户端给出可操作的配置提示。
 */
export interface CoreConfig {
  /** 应用配置文件。设置界面会把需要持久化的运行配置写回这里。 */
  envFile: string
  /** 模型服务地址 */
  baseUrl: string
  apiKey: string
  /** 固定使用的模型 id */
  model: string
  /** 是否已经具备发起模型请求所需的最小配置。 */
  modelConfigured: boolean
  /** 模型上下文窗口大小，compaction（压缩）机制据此判断何时执行 */
  contextWindow: number
  /** 单轮回复的输出预算，参与上下文计算，并作为 `max_tokens` 发送给模型服务 */
  maxOutputTokens: number
  /** 数据目录：会话日志、context snapshot（快照）和工具输出都在这里 */
  dataDir: string
  /** 采样温度，未配置时不发送该字段 */
  temperature?: number
  /** 附加请求头 */
  headers?: Record<string, string>
}

/** 默认上下文窗口。取一个保守值：宁可提前执行 compaction（压缩），也不要撞上上下文超限。 */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** 默认输出预算，与上下文窗口一起决定 compaction（压缩）阈值。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

/**
 * 默认数据目录。
 *
 * 默认位于默认工作目录 `~/easycode` 下。工具检索会忽略 `.easycode`，
 * 避免会话日志和工具输出重新进入模型上下文；用户仍可通过环境变量覆盖。
 *
 * 注意这里保留 `~` 写法，真正的展开在下面统一完成。
 */
const DEFAULT_DATA_DIR = "~/easycode/.easycode"

export interface LoadConfigOptions {
  /** 工作目录，用于定位 .env 与解析相对路径 */
  cwd?: string
  /** 显式指定 .env 路径，优先于 cwd 推断 */
  envFile?: string
}

/**
 * 加载配置。
 *
 * .env 的查找顺序：
 * 1. 显式传入的 envFile（桌面端主进程会算出绝对路径后传进来）
 * 2. 环境变量 EASYCODE_ENV_FILE
 * 3. `<cwd>/.env`
 *
 * 注意：这里读的是**应用自己的** .env，不是用户被操作项目里的 .env。
 * 后者是「被 agent 处理的对象」，可能装有数据库密码等敏感信息，
 * 把它当成 EasyCode 的配置读进来既语义混乱、又会让密钥进入模型上下文。
 */
export const loadCoreConfig = (options: LoadConfigOptions = {}): CoreConfig => {
  const cwd = options.cwd ?? process.cwd()

  const envFile = resolve(expandHome(options.envFile ?? process.env.EASYCODE_ENV_FILE ?? resolve(cwd, ".env")))
  loadEnvFile(envFile)

  const baseUrl = readString("OPENAI_BASE_URL") ?? "https://api.openai.com/v1"
  const apiKey = readString("OPENAI_API_KEY") ?? ""
  const model = readString("OPENAI_MODEL") ?? ""

  // 路径必须先展开 `~` 再 resolve：resolve 不认识 `~`，
  // 否则会在当前工作目录下创建一个名叫 `~` 的目录，且不会报错
  const dataDir = resolve(expandHome(readString("EASYCODE_DATA_DIR") ?? DEFAULT_DATA_DIR))

  const config: CoreConfig = {
    envFile,
    baseUrl,
    apiKey,
    model,
    modelConfigured: apiKey.length > 0 && model.length > 0,
    contextWindow: readPositiveInt("OPENAI_MODEL_CONTEXT_WINDOW") ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: readPositiveInt("OPENAI_MAX_OUTPUT_TOKENS") ?? DEFAULT_MAX_OUTPUT_TOKENS,
    dataDir,
  }

  const temperature = readNumber("OPENAI_TEMPERATURE")
  if (temperature !== undefined) config.temperature = temperature

  const headers = readHeaders()
  if (headers) config.headers = headers

  logger.info("配置加载完成", {
    envFile: config.envFile,
    baseUrl: config.baseUrl,
    model: config.model,
    modelConfigured: config.modelConfigured,
    contextWindow: config.contextWindow,
    dataDir: config.dataDir,
    hasTemperature: temperature !== undefined,
    extraHeaderCount: headers ? Object.keys(headers).length : 0,
  })

  return config
}

/** 从配置中取出 LLM 客户端需要的连接信息。 */
export const toLLMClientConfig = (config: CoreConfig): LLMClientConfig => ({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  ...(config.headers ? { headers: config.headers } : {}),
})

const readString = (key: string): string | undefined => {
  const value = process.env[key]?.trim()
  return value && value.length > 0 ? value : undefined
}

const readNumber = (key: string): number | undefined => {
  const raw = readString(key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    logger.warn(`${key} 不是合法数字，已忽略`, { value: raw })
    return undefined
  }
  return value
}

const readPositiveInt = (key: string): number | undefined => {
  const value = readNumber(key)
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) {
    logger.warn(`${key} 必须是正整数，已忽略`, { value })
    return undefined
  }
  return value
}

/**
 * 解析附加请求头，格式为 `KEY1=VALUE1,KEY2=VALUE2`。
 *
 * 存在的意义是兼容需要特殊头的网关（例如要求自定义 project 头、
 * 或需要伪造 referer 才能调通的中转服务）。
 */
const readHeaders = (): Record<string, string> | undefined => {
  const raw = readString("OPENAI_EXTRA_HEADERS")
  if (!raw) return undefined

  const headers: Record<string, string> = {}
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf("=")
    if (separator <= 0) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (name.length > 0) headers[name] = value
  }

  return Object.keys(headers).length > 0 ? headers : undefined
}

/** 判断数据目录是否已存在，用于区分「首次启动」与「已有历史会话」。 */
export const dataDirExists = (config: CoreConfig): boolean => existsSync(config.dataDir)
