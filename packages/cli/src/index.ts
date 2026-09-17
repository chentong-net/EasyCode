#!/usr/bin/env node
import { randomBytes } from "node:crypto"

import { createCore, type Core } from "@easycode/core"
import { DEFAULT_WORKSPACE_DIRECTORY } from "@easycode/protocol"
import { listen } from "@easycode/server"

import { parseArgs, readFlagBoolean, readFlagString, type ParsedArgs } from "./args.js"
import { createSessionRenderer, createTerminalIO } from "./render.js"

/**
 * 命令行入口。
 *
 * 它的存在有两个目的：
 * 1. 不装桌面端也能使用 EasyCode
 * 2. 作为「Core 与界面分离」这条架构约束的活证据——这个文件只用 core 与 server
 *    的公开接口，不 import 任何渲染层代码。如果哪天 Core 里长出了界面相关的
 *    依赖，它会第一个编译失败。
 *
 * 三个子命令：run（跑一次任务）、sessions（看会话列表）、serve（起 HTTP 服务）。
 */

/** 等待回合结束时的轮询间隔。回合本来就有网络往返，这个密度不会造成负担。 */
const IDLE_POLL_MS = 200

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === undefined || args.command === "help" || readFlagBoolean(args, "help")) {
    printHelp()
    return
  }

  switch (args.command) {
    case "run":
      await runCommand(args)
      return
    case "sessions":
      await sessionsCommand(args)
      return
    case "serve":
      await serveCommand(args)
      return
    default:
      process.stderr.write(`未知命令：${args.command}\n\n`)
      printHelp()
      process.exitCode = 1
  }
}

/* -------------------------------------------------------------------------- */
/* easycode run                                                                */
/* -------------------------------------------------------------------------- */

const runCommand = async (args: ParsedArgs): Promise<void> => {
  const text = args.positionals.join(" ").trim()
  if (text.length === 0) {
    process.stderr.write("用法：easycode run \"<你的要求>\" [--dir <目录>] [--session <会话ID>]\n")
    process.exitCode = 1
    return
  }

  const core = createCore()
  const io = createTerminalIO()

  try {
    const sessionID = await resolveSession(core, args, io)

    const renderer = createSessionRenderer({
      core,
      io,
      sessionID,
      showReasoning: readFlagBoolean(args, "reasoning"),
      logger: core.logger,
    })
    const detach = renderer.start()

    // 中断必须挂在这里：用户在 agent 干活的过程中按 Ctrl+C 是常规操作，
    // 没有它就只能等整个回合跑完
    const onSigint = (): void => {
      io.write("\n[正在中断…]\n")
      void core.sessions.interrupt(sessionID).catch((error) => {
        core.logger.warn("中断失败", { sessionID, error })
      })
    }
    process.on("SIGINT", onSigint)

    try {
      await core.sessions.prompt(sessionID, { text })
      await waitUntilIdle(core, sessionID)
    } finally {
      process.off("SIGINT", onSigint)
      detach()
    }

    io.write("\n")
  } finally {
    io.close()
    await core.shutdown()
  }
}

/** 解析要使用的会话：显式指定则复用，否则在工作目录下新建一个。 */
const resolveSession = async (core: Core, args: ParsedArgs, io: { write(text: string): void }): Promise<string> => {
  const explicit = readFlagString(args, "session")
  if (explicit !== undefined) {
    const session = await core.sessions.get(explicit)
    if (!session) throw new Error(`会话不存在：${explicit}`)
    return session.id
  }

  const directory = readFlagString(args, "dir") ?? DEFAULT_WORKSPACE_DIRECTORY
  const session = await core.sessions.create({ directory })
  io.write(`会话 ${session.id}\n工作目录 ${session.directory}\n\n`)
  return session.id
}

/** 轮询直到会话空闲。 */
const waitUntilIdle = async (core: Core, sessionID: string): Promise<void> => {
  while (core.sessions.isRunning(sessionID)) {
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
  }
}

/* -------------------------------------------------------------------------- */
/* easycode sessions                                                           */
/* -------------------------------------------------------------------------- */

const sessionsCommand = async (_args: ParsedArgs): Promise<void> => {
  const core = createCore()
  try {
    const sessions = await core.sessions.list()
    if (sessions.length === 0) {
      process.stdout.write("还没有任何会话。用 easycode run \"...\" 创建一个。\n")
      return
    }

    // 列宽按内容自适应，避免长标题把表格挤变形
    const rows = sessions.map((session) => ({
      id: session.id,
      title: session.title,
      directory: session.directory,
      updatedAt: formatTime(session.updatedAt),
    }))
    const idWidth = maxWidth(rows.map((row) => row.id))
    const titleWidth = Math.min(30, maxWidth(rows.map((row) => row.title)))

    for (const row of rows) {
      process.stdout.write(
        `${row.id.padEnd(idWidth)}  ${truncate(row.title, titleWidth).padEnd(titleWidth)}  ${row.updatedAt}  ${row.directory}\n`,
      )
    }
  } finally {
    await core.shutdown()
  }
}

/* -------------------------------------------------------------------------- */
/* easycode serve                                                              */
/* -------------------------------------------------------------------------- */

const serveCommand = async (args: ParsedArgs): Promise<void> => {
  const core = createCore()
  const port = readPort(args)

  // 默认生成随机令牌：即使只监听回环地址，也不该让本机任意程序
  // 无声地驱动一个能读写文件的 agent
  const token = readFlagBoolean(args, "no-token") ? "" : (readFlagString(args, "token") ?? randomBytes(24).toString("hex"))

  const server = await listen({
    core,
    port,
    ...(token.length === 0 ? {} : { token }),
    logger: core.logger,
  })

  process.stdout.write(
    [
      `服务地址 ${server.url}`,
      token.length === 0 ? "访问令牌 已禁用（--no-token）" : `访问令牌 ${token}`,
      "",
      "示例：",
      `  curl -H "x-easycode-token: ${token}" ${server.url}/api/health`,
      "",
      "按 Ctrl+C 退出。",
      "",
    ].join("\n"),
  )

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.stdout.write("\n正在退出…\n")
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })

  await server.close()
  await core.shutdown()
}

const readPort = (args: ParsedArgs): number => {
  const raw = readFlagString(args, "port")
  if (raw === undefined) return 0

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`端口不合法：${raw}`)
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* 辅助                                                                        */
/* -------------------------------------------------------------------------- */

const printHelp = (): void => {
  process.stdout.write(
    [
      "EasyCode —— 运行在本地机器上的编程助手",
      "",
      "用法：easycode <命令> [参数]",
      "",
      "命令：",
      '  run "<要求>"      在工作目录下执行一次任务，结果直接输出到终端',
      "  sessions          列出全部会话",
      "  serve             启动本地 HTTP 服务，供界面连接",
      "",
      "选项：",
      `  --dir <目录>      run 使用的工作目录，默认 ${DEFAULT_WORKSPACE_DIRECTORY}`,
      "  --session <ID>    run 复用一个已有会话，而不是新建",
      "  --reasoning       run 时展示模型的推理过程",
      "  --port <端口>     serve 监听的端口，默认由系统分配空闲端口",
      "  --token <令牌>    serve 使用的访问令牌，默认随机生成",
      "  --no-token        serve 关闭鉴权，仅用于本机调试",
      "  -h, --help        显示本帮助",
      "",
      "环境变量（可写在项目根目录的 .env 中）：OPENAI_BASE_URL / OPENAI_API_KEY /",
      "OPENAI_MODEL / OPENAI_MODEL_CONTEXT_WINDOW / OPENAI_MAX_OUTPUT_TOKENS /",
      "EASYCODE_DATA_DIR / EASYCODE_LOG_LEVEL",
      "",
    ].join("\n"),
  )
}

const maxWidth = (values: string[]): number => values.reduce((max, value) => Math.max(max, value.length), 1)

const truncate = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}…`

const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString("zh-CN", { hour12: false })

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
