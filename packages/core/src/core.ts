import { createAgentRegistry, type AgentRegistry } from "./agent.js"
import { loadCoreConfig, toLLMClientConfig, type CoreConfig, type LoadConfigOptions } from "./config.js"
import { createEventHub, type EventHub } from "./events.js"
import { createLLMClient } from "./llm/client.js"
import { createLogger, type Logger } from "./log.js"
import { createPermissionService, type PermissionService } from "./permission/service.js"
import { createRunner } from "./runner/index.js"
import { createCompactionManager } from "./session/compaction.js"
import { createSystemContextManager } from "./session/context.js"
import { createSessionManager, type SessionManager } from "./session/runtime.js"
import { createSessionStore, type SessionStore } from "./session/store.js"
import { createBuiltinTools } from "./tool/builtin/index.js"
import { createToolRegistry, type ToolRegistry } from "./tool/registry.js"
import { createWorkspaceManager, type WorkspaceManager } from "./workspace/manager.js"

/**
 * Core 的组装入口。
 *
 * 整个运行时的依赖图在这里一次性接好，外部（server / CLI / 未来的测试）只面对
 * 一个 `Core` 对象，不需要知道内部有哪些零件、谁依赖谁。
 * 这样做的直接好处是：想验证 Core 是否真的与 UI 无关，
 * 只要看这个文件有没有出现 HTTP 或 UI 相关的东西就够了。
 *
 * 装配顺序不是随意的：runner 需要会话管理器，而会话管理器又需要
 * runner 来实现「唤醒」——两者是双向的。这里用 `setRunDriver` 打破循环：
 * 先建好会话管理器，再建 runner，最后把它注册回去。
 */

/** 一个装配完成、可以直接使用的运行时。 */
export interface Core {
  config: CoreConfig
  store: SessionStore
  hub: EventHub
  agents: AgentRegistry
  sessions: SessionManager
  workspaces: WorkspaceManager
  permissions: PermissionService
  tools: ToolRegistry
  logger: Logger
  /** 关闭运行时：中止所有运行中的回合，不再接受新的执行 */
  shutdown(): Promise<void>
}

export interface CreateCoreOptions extends LoadConfigOptions {
  /**
   * 直接传入已加载好的配置。
   *
   * 桌面端与 CLI 都会提前加载配置（需要据此决定数据目录、日志文件位置），
   * 再传进来可以避免重复解析 .env 与重复打印「配置加载完成」日志。
   */
  config?: CoreConfig
  logger?: Logger
}

export const createCore = (options: CreateCoreOptions = {}): Core => {
  const logger = options.logger ?? createLogger("core")
  const config = options.config ?? loadCoreConfig(options)

  const agents = createAgentRegistry()
  const store = createSessionStore(config)
  const hub = createEventHub(logger)
  const llm = createLLMClient(toLLMClientConfig(config), logger.child("llm"))
  const permissions = createPermissionService({ config, logger: logger.child("permission") })
  const compaction = createCompactionManager({ config, llm, logger: logger.child("compaction") })
  const context = createSystemContextManager()
  const tools = createToolRegistry({
    tools: createBuiltinTools(),
    saveToolOutput: (content) => store.saveToolOutput(content),
    logger: logger.child("tool"),
  })

  const sessions = createSessionManager({ config, store, hub, agents, logger: logger.child("session") })
  const workspaces = createWorkspaceManager({ dataDir: config.dataDir, logger: logger.child("workspace") })

  const runner = createRunner({
    config,
    llm,
    sessions,
    agents,
    tools,
    permissions,
    compaction,
    context,
    hub,
    logger: logger.child("runner"),
  })

  // 双向依赖的收口点：会话管理器从此可以通过驱动唤醒回合
  sessions.setRunDriver(runner)

  logger.info("Core 已就绪", {
    model: config.model,
    dataDir: config.dataDir,
    toolCount: tools.definitions().length,
    agentCount: agents.all().length,
  })

  return {
    config,
    store,
    hub,
    agents,
    sessions,
    workspaces,
    permissions,
    tools,
    logger,
    shutdown: async () => {
      logger.info("正在关闭 Core")
      await sessions.shutdown()
    },
  }
}
