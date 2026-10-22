import { spawn } from "node:child_process"
import { z } from "zod"

import { ToolFailure } from "../../errors.js"
import { defineTool } from "../tool.js"
import { formatBytes } from "./read.js"

/**
 * 执行 shell 命令。
 *
 * 这是权限体系最重要的一道关口：它是唯一能让 agent 产生任意副作用的工具。
 * 每次调用都会把**完整命令字符串**提交给权限服务；默认规则允许普通命令，
 * 只有匹配到 `rm -rf`、`sudo` 等规则时才会进入人工审批。
 *
 * 实现上处理了三个真实会出问题的地方：
 *
 * 1. **进程组终止**。用 shell 执行 `npm test` 这类命令时，真正干活的是子进程，
 *    只 kill shell 本身会留下孤儿进程继续跑。所以启动时让子进程独立成组，
 *    终止时对整个组发信号。
 * 2. **输出上限**。命令可能输出几百 MB（构建日志、误操作的 cat），
 *    必须在读取阶段就限制，等到交给截断层已经太晚了。
 * 3. **超时**。默认两分钟，上限十分钟。没有超时的命令一旦卡住，
 *    整个会话就永远停在那里。
 */

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** 读取阶段的最大捕获量，超过后不再累积 */
const MAX_CAPTURE_BYTES = 1024 * 1024
/** 发出终止信号后等待多久升级为强杀 */
const KILL_ESCALATION_MS = 3_000

const inputSchema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  description: z
    .string()
    .optional()
    .describe("用一句话说明这条命令在做什么，作为工具调用入参记录"),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}`),
})

type Input = z.infer<typeof inputSchema>

export const bashTool = defineTool({
  name: "bash",
  description: [
    "在工作目录下执行 shell 命令，返回退出码与输出。",
    `默认超时 ${DEFAULT_TIMEOUT_MS / 1000} 秒，可通过 timeout 参数延长，最长 ${MAX_TIMEOUT_MS / 1000} 秒。`,
    "命令会以当前工作目录为基准执行。",
    "调用前会经过权限规则；需要人工审批时必须先获得用户确认。不要用它做无意义的试探（例如反复执行 ls）。",
    "读取文件请用 read，检索内容请用 grep/glob，不要用 cat 或 find。",
  ].join("\n"),
  input: inputSchema,
  effect: "command",
  resources: (input) => [input.command],
  // 记住的是完整命令字符串，因此保存后的规则只会自动允许完全相同的命令。
  savePatterns: (input) => [input.command],
  execute: async (input, context) => {
    const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    await context.authorize({ action: "bash", resources: [input.command], save: [input.command] })

    const child = spawn(input.command, {
      cwd: context.directory,
      shell: true,
      // 非 Windows 上让子进程独立成组，便于连同它派生的进程一起终止
      detached: process.platform !== "win32",
      env: { ...process.env, EASYCODE_AGENT: "1" },
    })

    let stdout = ""
    let stderr = ""
    let captured = 0
    let captureTruncated = false
    let timedOut = false
    let aborted = false

    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = MAX_CAPTURE_BYTES - captured
      if (remaining <= 0) {
        captureTruncated = true
        return
      }
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      captured += slice.byteLength
      if (chunk.byteLength > remaining) captureTruncated = true
      if (target === "stdout") stdout += slice.toString("utf8")
      else stderr += slice.toString("utf8")
    }

    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk))
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk))

    /** 终止整个进程组，先温和后强杀。 */
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || child.exitCode !== null) return
      if (process.platform === "win32") {
        child.kill(signal)
        return
      }
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 进程组可能已经不存在，退化为只杀直接子进程
        try {
          child.kill(signal)
        } catch {
          // 进程已经退出，忽略
        }
      }
    }

    const escalate = (): void => {
      terminate("SIGTERM")
      const timer = setTimeout(() => terminate("SIGKILL"), KILL_ESCALATION_MS)
      timer.unref()
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      escalate()
    }, timeoutMs)
    timeoutTimer.unref()

    const onAbort = (): void => {
      aborted = true
      escalate()
    }
    context.signal.addEventListener("abort", onAbort, { once: true })

    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
      (resolve) => {
        child.once("error", (error) => resolve({ code: null, signal: null, error }))
        child.once("close", (code, signal) => resolve({ code, signal }))
      },
    )

    clearTimeout(timeoutTimer)
    context.signal.removeEventListener("abort", onAbort)

    if (aborted) throw new ToolFailure("命令已被中断", { kind: "aborted" })

    context.logger.info("命令执行结束", {
      command: input.command,
      exitCode: outcome.code,
      timedOut,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    })

    const sections: string[] = [`$ ${input.command}`]

    if (outcome.error) {
      sections.push(`命令启动失败：${outcome.error.message}`)
    } else if (timedOut) {
      sections.push(`命令超时（超过 ${timeoutMs}ms），已被强制终止`)
    } else {
      const signal = outcome.signal ? `，终止信号 ${outcome.signal}` : ""
      sections.push(`退出码：${outcome.code ?? "未知"}${signal}`)
    }

    if (stdout.trim().length > 0) sections.push("--- 标准输出 ---", stdout.trimEnd())
    if (stderr.trim().length > 0) sections.push("--- 标准错误 ---", stderr.trimEnd())
    if (stdout.trim().length === 0 && stderr.trim().length === 0) sections.push("（命令没有产生任何输出）")
    if (captureTruncated) sections.push(`（输出超过 ${formatBytes(MAX_CAPTURE_BYTES)}，已截断）`)

    const failed = outcome.error !== undefined || timedOut || outcome.code !== 0
    const failureKind = outcome.error ? "internal" : timedOut ? "timeout" : "command_failed"
    const verification = inferVerification(input.command, failed)

    return {
      ...(failed
        ? {
            status: "error" as const,
            error: outcome.error
              ? `命令启动失败：${outcome.error.message}`
              : timedOut
                ? `命令超时（超过 ${timeoutMs}ms）`
                : `命令退出码为 ${outcome.code ?? "未知"}`,
          }
        : {}),
      output: {
        command: input.command,
        exitCode: outcome.code,
        signal: outcome.signal,
        timedOut,
        stdout,
        stderr,
      },
      content: [{ type: "text", text: sections.join("\n") }],
      metadata: {
        effect: "command",
        ...(failed ? { failureKind } : {}),
        ...(verification ? { verification } : {}),
      },
    }
  },
})

const VERIFICATION_COMMAND =
  /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|build|lint|check)(\s|$)|(^|\s)(vitest|jest|pytest|tsc|go\s+test|cargo\s+test|swift\s+test)(\s|$)/i

const inferVerification = (command: string, failed: boolean) =>
  VERIFICATION_COMMAND.test(command)
    ? {
        status: failed ? ("failed" as const) : ("passed" as const),
        command,
        summary: failed ? "验证命令执行失败" : "验证命令执行成功",
      }
    : undefined

export type { Input }
