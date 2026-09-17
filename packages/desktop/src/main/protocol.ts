import { net, protocol } from "electron"
import { join, normalize, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * 渲染层的自定义协议。
 *
 * 为什么不用 `loadFile`（也就是 file:// 协议）：
 * 渲染层是 ES 模块（`<script type="module">`），而 file:// 页面在 Chromium 里
 * 属于不透明来源，模块脚本的加载会受到跨域规则限制，能否成功取决于
 * Electron 版本与安全开关，属于「本地能跑、换台机器就白屏」的那类问题。
 *
 * 注册一个自己的标准协议之后：
 * - 页面有了稳定的来源（`app://easycode`），模块脚本、CSP、相对路径都按常规规则工作
 * - 不需要为了让它跑起来而关掉 webSecurity，安全基线保持不变
 * - 路径解析完全由我们控制，可以显式拒绝目录穿越
 *
 * `registerAppScheme` 必须在 app ready **之前**调用，否则协议特权不会生效。
 */

export const APP_SCHEME = "app"

/** 页面入口地址。 */
export const APP_ENTRY_URL = `${APP_SCHEME}://easycode/index.html`

export const registerAppScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        // standard 是模块脚本能按 URL 语义解析的前提
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * 把 `app://easycode/<path>` 映射到渲染层的构建产物目录。
 *
 * 目录穿越必须显式拦截：即使这里的页面只由我们自己构建，
 * 一个 `../../` 就能让页面读到应用包之外的任意文件。
 */
export const serveRendererFiles = (rendererDir: string): void => {
  const root = resolve(rendererDir)

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const pathname = decodeURIComponent(url.pathname)
    const target = resolve(join(root, normalize(pathname)))

    if (relative(root, target).startsWith("..")) {
      return new Response("禁止访问应用包之外的路径", { status: 403 })
    }

    return net.fetch(pathToFileURL(target).toString())
  })
}
