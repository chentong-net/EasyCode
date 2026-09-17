import { writeFile } from "node:fs/promises"

import { createCore, createLogger } from "@easycode/core"
import { listen } from "@easycode/server"

/**
 * Core sidecar。
 *
 * 它把 Core 包装成一个独立的本地服务进程，由 Electron 的 utilityProcess 拉起。
 * 为什么不直接在主进程里跑：agent 会执行命令、读写文件、长时间占用事件循环，
 * 放在主进程里任何一个环节卡住，整个界面都会失去响应。
 * 独立进程之后，界面卡死与 agent 卡死变成两件互不影响的事，
 * 而且这个进程可以被直接从命令行启动调试（`easycode serve` 就是同一条路径）。
 *
 * 与环境变量的约定（由主进程注入）：
 * - EASYCODE_ENV_FILE：模型配置文件位置
 * - EASYCODE_SERVER_PORT：监听端口，0 表示由系统分配
 * - EASYCODE_SERVER_TOKEN：访问令牌
 * - EASYCODE_READY_FILE：就绪后写入地址的握手文件
 */

/** 端口取值兜底：环境变量缺失或非法时交给系统分配，而不是退回某个固定端口。 */
const readPort = (raw: string | undefined): number => {
  if (raw === undefined) return 0
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0
}

const main = async (): Promise<void> => {
  const logger = createLogger("sidecar")
  const envFile = process.env.EASYCODE_ENV_FILE

  // 配置错误（缺少 API Key、模型未指定）会在这里直接抛出，
  // 进程以非零码退出，主进程据此在界面上给出可读的失败原因
  const core = createCore(envFile === undefined || envFile.length === 0 ? {} : { envFile })

  const token = process.env.EASYCODE_SERVER_TOKEN
  const server = await listen({
    core,
    port: readPort(process.env.EASYCODE_SERVER_PORT),
    ...(token === undefined || token.length === 0 ? {} : { token }),
    logger: core.logger,
  })

  // 握手：把实际监听到的地址写给主进程。端口由系统分配，只有这里知道结果
  const readyFile = process.env.EASYCODE_READY_FILE
  if (readyFile !== undefined && readyFile.length > 0) {
    await writeFile(readyFile, JSON.stringify({ url: server.url, port: server.port }), "utf8")
    logger.info("已写入就绪文件", { readyFile, url: server.url })
  }

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    logger.info("收到退出信号，正在关闭", { signal })
    // 先停服务再关运行时：反过来的话，正在执行的回合会尝试通过已经关闭的
    // 服务推送事件，产生一串没有意义的报错
    await server.close()
    await core.shutdown()
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  logger.info("sidecar 已进入服务状态", { url: server.url })
}

void main().catch((error: unknown) => {
  process.stderr.write(`[sidecar] 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
