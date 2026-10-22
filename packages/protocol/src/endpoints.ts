/**
 * HTTP 端点定义。
 *
 * 之所以把路径集中在这里而不是散落在 server 和 client 里，是为了让「契约」
 * 只有一份：server 注册路由时用它，client 拼 URL 时也用它。
 * 两边各写一遍字符串是迟早要出错的——改了一边忘了另一边，
 * 结果就是运行时的 404，而且类型系统完全帮不上忙。
 *
 * 路径参数一律走 encodeURIComponent，避免会话 id 里的特殊字符把路径撕开。
 */

/** 所有接口共有的前缀。 */
export const API_PREFIX = "/api"

/**
 * 接口契约版本。
 *
 * 桌面端与 sidecar 是分别构建的产物。健康检查会返回这个常量，
 * 供调用方排查版本错配；当前实现还没有在启动时自动校验它。
 */
export const API_VERSION = "0.1.0"

/** 鉴权头名称。桌面端的渲染进程从 preload 拿到 token 后放在这个头里。 */
export const AUTH_HEADER = "x-easycode-token"

/**
 * 事件流的查询参数名。
 *
 * `after` 是 SSE 断线重连的关键：带上上次收到的最大 seq，
 * 服务端只补发之后的事件，UI 就不需要重新拉取整个会话。
 */
export const AFTER_QUERY_PARAM = "after"

const segment = (value: string): string => encodeURIComponent(value)

/** 单个会话的路径。其它会话级端点都基于它拼接。 */
export const sessionPath = (sessionID: string): string => `${API_PREFIX}/sessions/${segment(sessionID)}`

export const Endpoints = {
  /** 健康检查。渲染层用它读取模型与上下文窗口信息；主进程通过就绪文件判断 sidecar 是否启动完成。 */
  health: (): string => `${API_PREFIX}/health`,

  /** 可用的 agent 列表 */
  agents: (): string => `${API_PREFIX}/agents`,

  /** 会话集合：GET 列表 / POST 创建 */
  sessions: (): string => `${API_PREFIX}/sessions`,

  /** 单个会话：GET 详情 */
  session: (sessionID: string): string => sessionPath(sessionID),

  /** 置顶或取消置顶会话 */
  pinSession: (sessionID: string): string => `${sessionPath(sessionID)}/pin`,

  /** 会话的消息列表 */
  messages: (sessionID: string): string => `${sessionPath(sessionID)}/messages`,

  /** 提交一条用户输入 */
  prompt: (sessionID: string): string => `${sessionPath(sessionID)}/prompt`,

  /** 中断当前回合 */
  interrupt: (sessionID: string): string => `${sessionPath(sessionID)}/interrupt`,

  /** 事件流（SSE） */
  events: (sessionID: string): string => `${sessionPath(sessionID)}/events`,

  /** 待审批的权限请求列表 */
  permissions: (sessionID: string): string => `${sessionPath(sessionID)}/permissions`,

  /** 回应某个权限请求 */
  permissionReply: (sessionID: string, requestID: string): string =>
    `${sessionPath(sessionID)}/permissions/${segment(requestID)}/reply`,
} as const

/** 给事件流 URL 附加 `after` 参数，after 为 undefined 时不附加。 */
export const withAfter = (url: string, after: number | undefined): string =>
  after === undefined ? url : `${url}?${AFTER_QUERY_PARAM}=${after}`
