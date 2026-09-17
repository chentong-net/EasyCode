import { randomBytes } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { utilityProcess } from "electron"

import { log } from "./log"

/**
 * 启动 Core sidecar（本地 HTTP 服务），并等它真正可用。
 *
 * 这里刻意**不使用 IPC**。主进程与 Core 之间隔着一条 HTTP 通道，
 * 所有能力都通过接口暴露，好处是：
 * - 桌面端与命令行、将来的其它端走完全相同的代码路径，
 *   不存在「只在桌面上才会触发的 bug」
 * - 界面刷新、重连、甚至换成一个浏览器标签页访问，都不需要改 Core
 *
 * 代价是启动时需要一个握手：sidecar 监听在系统分配的空闲端口上，
 * 端口号只有它自己知道。因此用一个「就绪文件」把地址回传给主进程——
 * 比让主进程先猜一个端口再传下去更可靠，那种做法存在端口被抢占的竞态。
 *
 * 鉴权令牌由主进程生成后通过环境变量传入，最终注入渲染进程。
 * sidecar 只监听回环地址，加上令牌之后，本机其它程序无法无声地驱动 agent。
 */

/** 等待就绪的超时时间。包含加载配置、建立 HTTP 服务的全部时间，通常远小于 1 秒。 */
const READY_TIMEOUT_MS = 20_000

/** 轮询就绪文件的间隔。 */
const READY_POLL_MS = 100

/** 保留多少行 sidecar 输出用于报错。过多会占内存，过少则看不出原因。 */
const STDERR_BUFFER_LINES = 40

export interface StartSidecarOptions {
  /** sidecar 入口脚本绝对路径 */
  entry: string
  envFile: string
  logFile: string
  readyFile: string
  timeoutMs?: number
}

export interface Sidecar {
  /** 服务地址，例如 http://127.0.0.1:53421 */
  url: string
  /** 访问令牌 */
  token: string
  /** 注册退出回调。sidecar 意外退出时需要提示用户，并决定是否重启。 */
  onExit(listener: (code: number) => void): void
  /** 停止 sidecar */
  stop(): void
}

export const startSidecar = async (options: StartSidecarOptions): Promise<Sidecar> => {
  const token = randomBytes(32).toString("hex")

  // 上一次运行残留的就绪文件会让这次误判为「已就绪」，必须先清掉
  await rm(options.readyFile, { force: true })

  const child = utilityProcess.fork(options.entry, [], {
    serviceName: "EasyCode Core",
    stdio: "pipe",
    // 工作目录固定为配置文件所在目录。默认情况下进程会继承主进程的 cwd
    // （开发时是 packages/desktop），一旦配置里出现相对路径，
    // 生成的文件就会落在应用包里，而不是用户以为的地方
    cwd: dirname(options.envFile),
    // 必须显式继承父进程环境：Node 的 fork 语义是「整体替换」，
    // 不继承的话 PATH 之类的变量会消失，子进程里任何 spawn 都会失败
    env: {
      ...process.env,
      EASYCODE_ENV_FILE: options.envFile,
      EASYCODE_LOG_FILE: options.logFile,
      EASYCODE_SERVER_TOKEN: token,
      EASYCODE_SERVER_PORT: "0",
      EASYCODE_READY_FILE: options.readyFile,
    },
  })

  const recentLines: string[] = []
  const capture = (level: "info" | "warn", chunk: Buffer): void => {
    const text = chunk.toString("utf8").trimEnd()
    if (text.length === 0) return

    for (const line of text.split("\n")) {
      recentLines.push(line)
      if (recentLines.length > STDERR_BUFFER_LINES) recentLines.shift()
    }

    // sidecar 已经自己写日志文件了，这里只转发到主进程的 stderr，
    // 方便开发时在同一个终端里看到全部输出
    log[level]("sidecar 输出", { line: text })
  }

  child.stdout?.on("data", (chunk: Buffer) => capture("info", chunk))
  child.stderr?.on("data", (chunk: Buffer) => capture("warn", chunk))

  const exitPromise = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      log.warn("sidecar 已退出", { code })
      resolve(code ?? 0)
    })
  })

  /** 子进程是否已经退出。用一个标志位而不是在轮询里反复挂 then，避免堆积回调。 */
  let exitCode: number | undefined
  void exitPromise.then((code) => {
    exitCode = code
  })

  try {
    const ready = await waitForReady(options.readyFile, options.timeoutMs ?? READY_TIMEOUT_MS, () => exitCode)
    log.info("sidecar 已就绪", { url: ready.url })
    return {
      url: ready.url,
      token,
      onExit: (listener) => {
        void exitPromise.then(listener)
      },
      stop: () => {
        log.info("正在停止 sidecar")
        child.kill()
      },
    }
  } catch (error) {
    // 启动失败时子进程可能还活着，直接杀掉，避免留下一个抓不到地址的孤儿进程
    child.kill()
    const detail = recentLines.length > 0 ? `\nsidecar 输出：\n${recentLines.join("\n")}` : ""
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`)
  }
}

interface ReadyInfo {
  url: string
  port: number
}

/**
 * 轮询等待就绪文件出现。
 *
 * 同时检查子进程是否退出：只等文件的话，sidecar 因为配置错误（比如缺少 API Key）
 * 立刻崩溃时，用户要等满超时才能看到报错，而真正的原因早就已经打印出来了。
 */
const waitForReady = async (
  readyFile: string,
  timeoutMs: number,
  readExitCode: () => number | undefined,
): Promise<ReadyInfo> => {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const info = await readReady(readyFile)
    if (info) return info

    const code = readExitCode()
    if (code !== undefined) throw new Error(`Core 服务启动失败并已退出（退出码 ${code}）`)

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }

  throw new Error(`等待 Core 服务就绪超时（${timeoutMs} 毫秒）`)
}

const readReady = async (readyFile: string): Promise<ReadyInfo | undefined> => {
  let raw: string
  try {
    raw = await readFile(readyFile, "utf8")
  } catch {
    // 文件还没写出来，属于正常情况
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as ReadyInfo
    return typeof parsed.url === "string" && parsed.url.length > 0 ? parsed : undefined
  } catch {
    // 可能正好读到写了一半的内容，下一轮再来
    return undefined
  }
}
