import type { PermissionEffect, PermissionRule } from "@easycode/schema"

import { createLogger } from "../log.js"

const logger = createLogger("permission.rules")

/**
 * 权限规则求值。
 *
 * 规则模型与 OpenCode 一致：`{ action, resource, effect }`，
 * 取**最后一条同时匹配 action 与 resource 的规则**，没有规则命中时默认 `ask`。
 *
 * 之所以用「最后一条命中」而不是「第一条命中」，是因为这样规则集可以分层书写：
 * 先写宽松的兜底规则，后面的收紧规则自然覆盖它，不需要考虑优先级字段。
 */

/** 通配符正则缓存。规则集很小，但求值发生在每次工具调用上。 */
const patternCache = new Map<string, RegExp>()

/**
 * 通配符匹配。
 *
 * `*` 匹配任意字符（包括路径分隔符），`?` 匹配单个字符。
 * 注意这里的 `*` 不区分路径层级——`src/*` 能匹配 `src/a/b.ts`。
 * 这是刻意的：权限规则的书写者关心的是「哪一类操作」，
 * 而不是 shell 通配符的精确语义，宽松一点更符合直觉也更安全。
 */
export const matchWildcard = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === value

  const cached = patternCache.get(pattern)
  if (cached) return cached.test(value)

  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const regexp = new RegExp(`^${source}$`)
  patternCache.set(pattern, regexp)
  return regexp.test(value)
}

export interface PermissionDecision {
  effect: PermissionEffect
  /** 命中的规则。未命中任何规则时为空，此时 effect 为默认值 ask。 */
  rule?: PermissionRule
}

/** 效果的严格程度，数值越大越严格。用于多资源场景取最严格结果。 */
const EFFECT_WEIGHT: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 }

/** 取两个效果中更严格的一个。 */
export const strictestEffect = (a: PermissionEffect, b: PermissionEffect): PermissionEffect =>
  EFFECT_WEIGHT[a] >= EFFECT_WEIGHT[b] ? a : b

/**
 * 对单个资源求值。
 *
 * rulesets 按「优先级从低到高」排列，最后传入的规则集优先级最高
 * （用户保存的「总是允许」规则因此能覆盖 agent 的默认规则集）。
 */
export const evaluateResource = (action: string, resource: string, rulesets: PermissionRule[][]): PermissionDecision => {
  let decision: PermissionDecision = { effect: "ask" }

  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (!matchWildcard(rule.action, action)) continue
      if (!matchWildcard(rule.resource, resource)) continue
      decision = { effect: rule.effect, rule }
    }
  }

  return decision
}

/**
 * 对一组资源求值，取最严格的结果。
 *
 * 「一次工具调用申请多个资源」是常见情况（例如 apply_patch 同时改多个文件），
 * 只要其中任意一个需要确认，整次调用就需要确认。
 */
export const evaluateResources = (
  action: string,
  resources: string[],
  rulesets: PermissionRule[][],
): PermissionDecision => {
  const targets = resources.length > 0 ? resources : [""]

  let effect: PermissionEffect = "allow"
  let matched: PermissionRule | undefined

  for (const resource of targets) {
    const decision = evaluateResource(action, resource, rulesets)
    if (decision.rule && EFFECT_WEIGHT[decision.effect] >= EFFECT_WEIGHT[effect]) {
      matched = decision.rule
    }
    effect = strictestEffect(effect, decision.effect)
  }

  logger.debug("权限求值结果", { action, resourceCount: targets.length, effect, matchedRule: matched })
  return { effect, ...(matched ? { rule: matched } : {}) }
}
