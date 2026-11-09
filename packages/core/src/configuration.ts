import { randomUUID } from "node:crypto"
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import {
  renderStoredRuntimeConfig,
  type CoreConfig,
  type StoredRuntimeConfig,
} from "./config.js"
import { createLLMClient } from "./llm/client.js"
import { describeError } from "./llm/error.js"
import type { CoreWebConfig, WebProviderID } from "./tool/builtin/web/types.js"

export type RuntimeLogLevel = StoredRuntimeConfig["logLevel"]

/**
 * 配置界面的安全视图。
 *
 * API Key 等敏感值只返回“是否已配置”，不把明文送进渲染进程。用户留空
 * 密钥输入框时表示保持原值；显式清除则通过 update 中的 null 表达。
 */
export interface RuntimeConfigView {
  configFile: string
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
  webTimeoutMs: number
  webMaxResponseBytes: number
  webUserAgent: string
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
  webTimeoutMs: number
  webMaxResponseBytes: number
  webUserAgent: string
  logLevel: RuntimeLogLevel
}

export interface ConfigurationService {
  read(): Promise<RuntimeConfigView>
  update(input: RuntimeConfigUpdate): Promise<RuntimeConfigView>
  testModel(input: ModelConnectionTestInput): Promise<ModelConnectionTestResult>
}

export interface ModelConnectionTestInput {
  baseUrl: string
  model: string
  apiKey?: string | null
  extraHeaders?: string | null
}

export interface ModelConnectionTestResult {
  ok: boolean
  latencyMs: number
  model: string
  message?: string
}

interface ConfigurationDeps {
  config: CoreConfig
}

export const createConfigurationService = (deps: ConfigurationDeps): ConfigurationService => {
  let current = toStoredConfig(deps.config)
  let writes = Promise.resolve()

  const read = async (): Promise<RuntimeConfigView> => toView(deps.config.configFile, current)

  const update = (input: RuntimeConfigUpdate): Promise<RuntimeConfigView> => {
    const operation = writes.then(async () => {
      const next = applyUpdate(current, normalizeUpdate(input))
      await writeConfigFile(deps.config.configFile, next)
      current = next
      return toView(deps.config.configFile, current)
    })
    writes = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  const testModel = async (input: ModelConnectionTestInput): Promise<ModelConnectionTestResult> => {
    const model = input.model.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "")
    const apiKey = input.apiKey === undefined ? current.apiKey : (input.apiKey ?? "")
    const startedAt = Date.now()

    if (apiKey.length === 0) {
      return { ok: false, latencyMs: 0, model, message: "模型 API Key 尚未配置" }
    }
    if (model.length === 0) {
      return { ok: false, latencyMs: 0, model, message: "模型 ID 尚未配置" }
    }

    let headers: Record<string, string>
    try {
      headers =
        input.extraHeaders === undefined
          ? current.headers
          : input.extraHeaders === null
            ? {}
            : parseHeaders(input.extraHeaders)
    } catch (error) {
      return { ok: false, latencyMs: 0, model, message: describeError(error) }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    timer.unref()
    try {
      const client = createLLMClient({ baseUrl, apiKey, headers })
      for await (const event of client.stream({
        model,
        system: ["你是模型连通性测试。收到用户输入后只回复 OK，不要调用任何工具。"],
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        tools: [],
        maxOutputTokens: 16,
        sessionID: "easycode_connection_test",
        signal: controller.signal,
      })) {
        if (event.type === "finish") break
      }
      return { ok: true, latencyMs: Date.now() - startedAt, model }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        model,
        message: controller.signal.aborted ? "连接测试超时（15000ms）" : describeError(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return { read, update, testModel }
}

const toStoredConfig = (config: CoreConfig): StoredRuntimeConfig => ({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  model: config.model,
  contextWindow: config.contextWindow,
  maxOutputTokens: config.maxOutputTokens,
  ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
  headers: { ...config.headers },
  web: cloneWebConfig(config.web),
  logLevel: config.logLevel,
})

const cloneWebConfig = (web: CoreWebConfig): CoreWebConfig => ({
  ...web,
  search: { ...web.search },
  fetch: { ...web.fetch },
})

const toView = (configFile: string, config: StoredRuntimeConfig): RuntimeConfigView => ({
  configFile,
  baseUrl: config.baseUrl,
  model: config.model,
  modelConfigured: config.apiKey.length > 0 && config.model.length > 0,
  contextWindow: config.contextWindow,
  maxOutputTokens: config.maxOutputTokens,
  ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
  hasApiKey: config.apiKey.length > 0,
  hasExtraHeaders: Object.keys(config.headers).length > 0,
  ...(config.web.search.provider === undefined ? {} : { webSearchProvider: config.web.search.provider }),
  hasWebSearchApiKey: config.web.search.apiKey.length > 0,
  ...(config.web.fetch.provider === undefined ? {} : { webFetchProvider: config.web.fetch.provider }),
  hasWebFetchApiKey: config.web.fetch.apiKey.length > 0,
  webTimeoutMs: config.web.timeoutMs,
  webMaxResponseBytes: config.web.maxResponseBytes,
  webUserAgent: config.web.userAgent,
  logLevel: config.logLevel,
})

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
  webTimeoutMs: input.webTimeoutMs,
  webMaxResponseBytes: input.webMaxResponseBytes,
  webUserAgent: input.webUserAgent.trim(),
  logLevel: input.logLevel,
})

const normalizeSecret = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined || value === null) return value
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const applyUpdate = (current: StoredRuntimeConfig, input: RuntimeConfigUpdate): StoredRuntimeConfig => {
  const apiKey = input.apiKey === undefined ? current.apiKey : (input.apiKey ?? "")
  const searchApiKey =
    input.webSearchApiKey === undefined ? current.web.search.apiKey : (input.webSearchApiKey ?? "")
  const fetchApiKey =
    input.webFetchApiKey === undefined ? current.web.fetch.apiKey : (input.webFetchApiKey ?? "")
  const headers =
    input.extraHeaders === undefined
      ? current.headers
      : input.extraHeaders === null
        ? {}
        : parseHeaders(input.extraHeaders)
  const temperature =
    input.temperature === null ? undefined : (input.temperature ?? current.temperature)

  return {
    baseUrl: input.baseUrl,
    apiKey,
    model: input.model,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    ...(temperature === undefined ? {} : { temperature }),
    headers,
    web: {
      timeoutMs: input.webTimeoutMs,
      maxResponseBytes: input.webMaxResponseBytes,
      userAgent: input.webUserAgent,
      search: {
        ...(input.webSearchProvider === "" ? {} : { provider: input.webSearchProvider }),
        apiKey: searchApiKey,
      },
      fetch: {
        ...(input.webFetchProvider === "" ? {} : { provider: input.webFetchProvider }),
        apiKey: fetchApiKey,
      },
    },
    logLevel: input.logLevel,
  }
}

const parseHeaders = (text: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const separator = line.indexOf(":")
    if (separator <= 0) throw new Error(`附加请求头格式不正确：${line}。请使用 Name: Value`)
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`附加请求头名称不合法：${name}`)
    }
    headers[name] = value
  }
  return headers
}

const writeConfigFile = async (file: string, config: StoredRuntimeConfig): Promise<void> => {
  const content = renderStoredRuntimeConfig(config)
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
