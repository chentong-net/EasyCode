import { createClient } from "@easycode/client"
import { createRoot } from "react-dom/client"

import { App } from "./App"
import { hasHost, platform } from "./bridge"
import "./styles.css"

/**
 * 渲染层入口。
 *
 * 这里有一处刻意的取舍：**不使用 StrictMode**。
 * StrictMode 会在开发模式下把每个 effect 执行两次，对于「订阅一条长连接」
 * 这类副作用来说，结果是同一时刻挂着两条 SSE 连接，事件被重复消费。
 * 我们更希望开发时的行为与生产一致，所以关掉它，
 * 把「effect 必须能安全地重复执行」这件事交给代码本身去保证（每个 effect 都有清理函数）。
 */

const container = document.getElementById("root")

if (container === null) {
  throw new Error("页面缺少 #root 容器")
}

if (!hasHost) {
  // 在浏览器里直接打开这个页面时会走到这里。明确说明原因，
  // 比让用户面对一个连接失败的空白界面要好
  createRoot(container).render(<BridgeMissing />)
} else {
  // 平台信息挂到根元素上，样式据此决定是否给窗口左上角的红绿灯按钮让出位置
  document.documentElement.dataset.platform = platform

  const injected = window.easycode
  if (injected === undefined) {
    throw new Error("宿主环境信息不完整")
  }

  const client = createClient({
    baseUrl: injected.serverUrl,
    token: injected.serverToken,
    onInvalidEvent: (raw) => console.warn("[easycode] 收到无法解析的事件帧", raw),
    onReconnecting: ({ attempt, delayMs, reason }) =>
      console.warn(`[easycode] 事件流断开（${reason}），${delayMs}ms 后进行第 ${attempt} 次重连`),
  })

  createRoot(container).render(<App client={client} />)
}

function BridgeMissing() {
  return (
    <div className="bridge-missing">
      <h1>请通过桌面应用启动</h1>
      <p>这个页面需要由 Electron 主进程注入 Core 服务地址，无法在浏览器中直接打开。</p>
      <p>
        如果要调试界面，请在 packages/desktop 目录下运行 <code>npm run build &amp;&amp; npm start</code>。
      </p>
    </div>
  )
}
