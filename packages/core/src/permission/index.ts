/**
 * 权限体系。
 *
 * - rules：纯函数式的规则求值，决定 allow / ask / deny
 * - service：把求值结果落到实际行为上（挂起等待用户、记住规则、写事件日志）
 */
export * from "./rules.js"
export * from "./service.js"
