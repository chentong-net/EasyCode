import type { EasyCodeClient } from "@easycode/client"
import {
  RuntimeConfigResponse,
  RuntimeConfigUpdateRequest,
  type WebProvider,
} from "@easycode/protocol"
import { RotateCw, X } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"

import { hasHost, restartApp } from "./bridge"
import { describeError } from "./format"

interface ConfigForm {
  baseUrl: string
  model: string
  contextWindow: string
  maxOutputTokens: string
  temperature: string
  apiKey: string
  extraHeaders: string
  webSearchProvider: WebProvider | ""
  webSearchApiKey: string
  webFetchProvider: WebProvider | ""
  webFetchApiKey: string
  dataDir: string
  logLevel: RuntimeConfigResponse["logLevel"]
}

interface ClearState {
  apiKey: boolean
  extraHeaders: boolean
  webSearchApiKey: boolean
  webFetchApiKey: boolean
}

const EMPTY_FORM: ConfigForm = {
  baseUrl: "",
  model: "",
  contextWindow: "128000",
  maxOutputTokens: "8192",
  temperature: "",
  apiKey: "",
  extraHeaders: "",
  webSearchProvider: "",
  webSearchApiKey: "",
  webFetchProvider: "",
  webFetchApiKey: "",
  dataDir: "",
  logLevel: "info",
}

const EMPTY_CLEAR: ClearState = {
  apiKey: false,
  extraHeaders: false,
  webSearchApiKey: false,
  webFetchApiKey: false,
}

export const SettingsDialog = ({
  client,
  open,
  onClose,
}: {
  client: EasyCodeClient
  open: boolean
  onClose: () => void
}) => {
  const [config, setConfig] = useState<RuntimeConfigResponse | undefined>()
  const [form, setForm] = useState<ConfigForm>(EMPTY_FORM)
  const [clear, setClear] = useState<ClearState>(EMPTY_CLEAR)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setSaved(false)
    setError(undefined)
    setClear(EMPTY_CLEAR)
    void (async () => {
      try {
        const next = await client.config.get(controller.signal)
        if (controller.signal.aborted) return
        setConfig(next)
        setForm(toForm(next))
      } catch (cause) {
        if (!controller.signal.aborted) setError(describeError(cause))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [client, open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !saving && !restarting) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, open, restarting, saving])

  if (!open) return null

  const setField = <Key extends keyof ConfigForm>(key: Key, value: ConfigForm[Key]): void => {
    setSaved(false)
    setForm((current) => ({ ...current, [key]: value }))
  }

  const setSecret = (
    field: "apiKey" | "extraHeaders" | "webSearchApiKey" | "webFetchApiKey",
    value: string,
  ): void => {
    setSaved(false)
    setClear((current) => ({ ...current, [field]: false }))
    setForm((current) => ({ ...current, [field]: value }))
  }

  const toggleClear = (field: keyof ClearState): void => {
    setSaved(false)
    setClear((current) => ({ ...current, [field]: !current[field] }))
    setForm((current) => ({ ...current, [field]: "" }))
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (saving) return

    const contextWindow = Number(form.contextWindow)
    const maxOutputTokens = Number(form.maxOutputTokens)
    const temperatureText = form.temperature.trim()
    const temperature = temperatureText.length === 0 ? null : Number(temperatureText)

    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      setError("上下文窗口必须是正整数")
      return
    }
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      setError("单轮输出上限必须是正整数")
      return
    }
    if (temperature !== null && !Number.isFinite(temperature)) {
      setError("温度必须是数字，留空表示使用服务默认值")
      return
    }

    const input: RuntimeConfigUpdateRequest = {
      baseUrl: form.baseUrl,
      model: form.model,
      contextWindow,
      maxOutputTokens,
      temperature,
      ...secretUpdate("apiKey", form.apiKey, clear.apiKey),
      ...secretUpdate("extraHeaders", form.extraHeaders, clear.extraHeaders),
      webSearchProvider: form.webSearchProvider,
      ...secretUpdate("webSearchApiKey", form.webSearchApiKey, clear.webSearchApiKey),
      webFetchProvider: form.webFetchProvider,
      ...secretUpdate("webFetchApiKey", form.webFetchApiKey, clear.webFetchApiKey),
      dataDir: form.dataDir,
      logLevel: form.logLevel,
    }

    setSaving(true)
    setError(undefined)
    try {
      const next = await client.config.update(input)
      setConfig(next)
      setForm(toForm(next))
      setClear(EMPTY_CLEAR)
      setSaved(true)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setError(undefined)
    try {
      await restartApp()
    } catch (cause) {
      setError(describeError(cause))
      setRestarting(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={() => !saving && !restarting && onClose()}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <h2 id="settings-title">运行配置</h2>
            <p>配置保存在本机，不会上传到 EasyCode 服务。</p>
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            disabled={saving || restarting}
            aria-label="关闭设置"
            title="关闭设置"
          >
            <X size={18} strokeWidth={1.8} />
          </button>
        </header>

        <form className="settings-form" onSubmit={(event) => void submit(event)}>
          <div className="settings-body">
            {loading ? (
              <div className="settings-loading">正在读取配置…</div>
            ) : (
              <>
                {config !== undefined && (
                  <div className={`settings-status${config.modelConfigured ? " settings-status-ok" : ""}`}>
                    <span className="settings-status-dot" aria-hidden />
                    {config.modelConfigured ? "模型服务已配置，可以开始使用" : "模型服务尚未配置完成"}
                  </div>
                )}

                {error !== undefined && <div className="settings-error">{error}</div>}
                {saved && (
                  <div className="settings-saved">
                    <span>配置已保存。模型和联网工具需要重启应用后生效。</span>
                    {hasHost && (
                      <button type="button" className="btn btn-small" onClick={() => void restart()} disabled={restarting}>
                        <RotateCw size={13} />
                        {restarting ? "正在重启…" : "立即重启"}
                      </button>
                    )}
                  </div>
                )}

                <section className="settings-section">
                  <div className="settings-section-heading">
                    <h3>模型服务</h3>
                    <span>OpenAI 兼容协议</span>
                  </div>
                  <div className="settings-grid">
                    <Field label="接口地址" wide>
                      <input
                        value={form.baseUrl}
                        onChange={(event) => setField("baseUrl", event.target.value)}
                        placeholder="https://api.openai.com/v1"
                        spellCheck={false}
                        autoFocus={!config?.hasApiKey}
                      />
                    </Field>
                    <Field
                      label="模型 ID"
                      hint="会话创建后保持固定。切换模型会改变新会话使用的模型。"
                    >
                      <input
                        value={form.model}
                        onChange={(event) => setField("model", event.target.value)}
                        placeholder="例如 gpt-4o 或 deepseek-chat"
                        spellCheck={false}
                      />
                    </Field>
                    <SecretField
                      label="API Key"
                      configured={config?.hasApiKey === true}
                      clearing={clear.apiKey}
                      value={form.apiKey}
                      placeholder="留空保持当前密钥"
                      onChange={(value) => setSecret("apiKey", value)}
                      onToggleClear={() => toggleClear("apiKey")}
                    />
                    <Field label="上下文窗口" hint="用于判断何时压缩上下文。">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={form.contextWindow}
                        onChange={(event) => setField("contextWindow", event.target.value)}
                      />
                    </Field>
                    <Field label="单轮输出上限" hint="同时参与上下文预算计算。">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={form.maxOutputTokens}
                        onChange={(event) => setField("maxOutputTokens", event.target.value)}
                      />
                    </Field>
                    <Field label="温度" hint="留空表示使用模型服务默认值。">
                      <input
                        type="number"
                        step="0.1"
                        value={form.temperature}
                        onChange={(event) => setField("temperature", event.target.value)}
                        placeholder="默认"
                      />
                    </Field>
                    <SecretField
                      label="附加请求头"
                      configured={config?.hasExtraHeaders === true}
                      clearing={clear.extraHeaders}
                      value={form.extraHeaders}
                      placeholder="KEY1=VALUE1,KEY2=VALUE2"
                      multiline
                      onChange={(value) => setSecret("extraHeaders", value)}
                      onToggleClear={() => toggleClear("extraHeaders")}
                    />
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-heading">
                    <h3>联网能力</h3>
                    <span>搜索和网页读取可分别配置</span>
                  </div>
                  <div className="settings-grid">
                    <Field label="搜索服务">
                      <select
                        value={form.webSearchProvider}
                        onChange={(event) => setField("webSearchProvider", event.target.value as WebProvider | "")}
                      >
                        <option value="">不启用</option>
                        <option value="deepseek">DeepSeek Search</option>
                        <option value="glm">GLM Web Search</option>
                        <option value="tavily">Tavily Search</option>
                      </select>
                    </Field>
                    <SecretField
                      label="搜索 API Key"
                      configured={config?.hasWebSearchApiKey === true}
                      clearing={clear.webSearchApiKey}
                      value={form.webSearchApiKey}
                      placeholder="留空保持当前密钥"
                      onChange={(value) => setSecret("webSearchApiKey", value)}
                      onToggleClear={() => toggleClear("webSearchApiKey")}
                    />
                    <Field label="网页读取服务">
                      <select
                        value={form.webFetchProvider}
                        onChange={(event) => setField("webFetchProvider", event.target.value as WebProvider | "")}
                      >
                        <option value="">不启用</option>
                        <option value="deepseek">DeepSeek Fetch</option>
                        <option value="glm">GLM Reader</option>
                        <option value="tavily">Tavily Extract</option>
                      </select>
                    </Field>
                    <SecretField
                      label="网页读取 API Key"
                      configured={config?.hasWebFetchApiKey === true}
                      clearing={clear.webFetchApiKey}
                      value={form.webFetchApiKey}
                      placeholder="留空保持当前密钥"
                      onChange={(value) => setSecret("webFetchApiKey", value)}
                      onToggleClear={() => toggleClear("webFetchApiKey")}
                    />
                  </div>
                  <p className="settings-note">服务与对应密钥都配置后，Agent 才会获得相应工具。</p>
                </section>

                <section className="settings-section">
                  <div className="settings-section-heading">
                    <h3>本地运行</h3>
                    <span>修改后需要重启</span>
                  </div>
                  <div className="settings-grid">
                    <Field label="数据目录" wide hint="会话日志、上下文快照和工具输出都保存在这里。">
                      <input
                        value={form.dataDir}
                        onChange={(event) => setField("dataDir", event.target.value)}
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="日志级别">
                      <select
                        value={form.logLevel}
                        onChange={(event) =>
                          setField("logLevel", event.target.value as RuntimeConfigResponse["logLevel"])
                        }
                      >
                        <option value="debug">debug</option>
                        <option value="info">info</option>
                        <option value="warn">warn</option>
                        <option value="error">error</option>
                      </select>
                    </Field>
                  </div>
                  {config !== undefined && (
                    <p className="settings-path">
                      配置文件：<code>{config.envFile}</code>
                    </p>
                  )}
                </section>
              </>
            )}
          </div>

          <footer className="settings-footer">
            <span>环境变量优先级高于配置文件。</span>
            <div className="settings-footer-actions">
              <button type="button" className="btn" onClick={onClose} disabled={saving || restarting}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={loading || saving || restarting}>
                {saving ? "保存中…" : "保存配置"}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}

const Field = ({
  label,
  hint,
  wide = false,
  children,
}: {
  label: string
  hint?: string
  wide?: boolean
  children: React.ReactNode
}) => (
  <label className={`settings-field${wide ? " settings-field-wide" : ""}`}>
    <span className="settings-label">{label}</span>
    {children}
    {hint !== undefined && <span className="settings-hint">{hint}</span>}
  </label>
)

const SecretField = ({
  label,
  configured,
  clearing,
  value,
  placeholder,
  multiline = false,
  onChange,
  onToggleClear,
}: {
  label: string
  configured: boolean
  clearing: boolean
  value: string
  placeholder: string
  multiline?: boolean
  onChange: (value: string) => void
  onToggleClear: () => void
}) => (
  <label className="settings-field">
    <span className="settings-label-row">
      <span className="settings-label">{label}</span>
      <span className={configured && !clearing ? "settings-key-state settings-key-state-ok" : "settings-key-state"}>
        {clearing ? "保存后清除" : configured ? "已保存" : "未配置"}
      </span>
    </span>
    {multiline ? (
      <textarea
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={clearing ? "保存后将清除当前值" : placeholder}
        disabled={clearing}
        spellCheck={false}
      />
    ) : (
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={clearing ? "保存后将清除当前值" : placeholder}
        disabled={clearing}
        spellCheck={false}
      />
    )}
    {configured && (
      <button type="button" className="settings-clear-secret" onClick={onToggleClear}>
        {clearing ? "取消清除" : "清除已保存值"}
      </button>
    )}
  </label>
)

const toForm = (config: RuntimeConfigResponse): ConfigForm => ({
  baseUrl: config.baseUrl,
  model: config.model,
  contextWindow: String(config.contextWindow),
  maxOutputTokens: String(config.maxOutputTokens),
  temperature: config.temperature === undefined ? "" : String(config.temperature),
  apiKey: "",
  extraHeaders: "",
  webSearchProvider: config.webSearchProvider ?? "",
  webSearchApiKey: "",
  webFetchProvider: config.webFetchProvider ?? "",
  webFetchApiKey: "",
  dataDir: config.dataDir,
  logLevel: config.logLevel,
})

const secretUpdate = (
  field: "apiKey" | "extraHeaders" | "webSearchApiKey" | "webFetchApiKey",
  value: string,
  clearing: boolean,
): Partial<RuntimeConfigUpdateRequest> => {
  if (clearing) return { [field]: null }
  const trimmed = value.trim()
  return trimmed.length === 0 ? {} : { [field]: trimmed }
}
