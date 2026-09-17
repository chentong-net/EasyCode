import { AssistantRuntimeProvider } from "@assistant-ui/react"
import type { EasyCodeClient } from "@easycode/client"

import { Chat } from "./Chat"
import { useEasyCodeRuntime } from "./runtime"
import { Sidebar } from "./Sidebar"
import { useEasyCode } from "./store"
import { useWorkspace } from "./workspace"

/**
 * 应用外壳。
 *
 * 组装顺序上有两处依赖：运行时所需的会话状态来自 useEasyCode，而会话状态又依赖
 * 当前工作目录；界面里的消息原语则必须在 AssistantRuntimeProvider 内部。
 * 因此三者都在这里挂载，子组件只消费结果。
 *
 * 标题栏是自绘的（macOS 上系统标题栏被隐藏）：它同时承担窗口拖拽区的职责，
 * 并且要给左上角的红绿灯按钮让出位置，用样式按平台区分（见 styles.css）。
 */
export const App = ({ client }: { client: EasyCodeClient }) => {
  const workspace = useWorkspace()
  const store = useEasyCode(client, workspace.directory)
  const runtime = useEasyCodeRuntime(store)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app">
        <header className="title-bar">
          <span className="title-bar-text">EasyCode</span>
        </header>

        <div className="app-body">
          <Sidebar store={store} workspace={workspace} />
          <Chat store={store} workspace={workspace} />
        </div>
      </div>

      {store.error !== undefined && (
        <div className="error-toast" role="alert">
          <span>{store.error}</span>
          <button type="button" className="btn btn-small" onClick={store.clearError}>
            知道了
          </button>
        </div>
      )}
    </AssistantRuntimeProvider>
  )
}
