/**
 * 极简参数解析。
 *
 * 不引入命令行框架：命令只有三个、参数不到十个，手写解析反而更清楚，
 * 也不会把一堆用不到的特性带进来。支持的写法：
 *
 * ```
 * easycode run "修复这个 bug" --dir ~/easycode
 * easycode serve --port=8080  
 * easycode sessions
 * ```
 *
 * 规则只有两条：
 * - 第一个非选项参数是子命令，其余非选项参数按顺序放进 positionals
 * - `--key value` 与 `--key=value` 等价；后面跟着另一个选项时视为布尔开关
 */

export interface ParsedArgs {
  /** 子命令。未提供时为 undefined */
  command: string | undefined
  /** 子命令之后的非选项参数 */
  positionals: string[]
  /** 选项。值可能是字符串，也可能是 true（布尔开关） */
  flags: Record<string, string | boolean>
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue

    if (token === "-h" || token === "--help") {
      flags.help = true
      continue
    }

    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const separator = body.indexOf("=")
    if (separator >= 0) {
      flags[body.slice(0, separator)] = body.slice(separator + 1)
      continue
    }

    const next = argv[index + 1]
    // 下一个 token 不是选项才算作这个选项的值，否则当成布尔开关
    if (next !== undefined && !next.startsWith("-")) {
      flags[body] = next
      index += 1
      continue
    }
    flags[body] = true
  }

  const [command, ...rest] = positionals
  return { command, positionals: rest, flags }
}

/** 读取字符串选项。未提供或为布尔开关时返回 undefined。 */
export const readFlagString = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags[name]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** 读取布尔选项。 */
export const readFlagBoolean = (args: ParsedArgs, name: string): boolean => args.flags[name] === true
