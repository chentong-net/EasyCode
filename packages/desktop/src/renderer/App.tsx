import type { EasyCodeClient } from "@easycode/client"

import { Chat } from "./Chat"
import { Sidebar } from "./Sidebar"
import { useEasyCode } from "./store"
import { useWorkspace } from "./workspace"

/**
 * 应用外壳。
 *
 * 会话状态来自 useEasyCode，子组件直接消费领域消息和操作，不再经过额外的
 * UI runtime 适配层。
 *
 * 标题栏是自绘的（macOS 上系统标题栏被隐藏）：它同时承担窗口拖拽区的职责，
 * 并且要给左上角的红绿灯按钮让出位置，用样式按平台区分（见 styles.css）。
 */
export const App = ({ client }: { client: EasyCodeClient }) => {
  const workspace = useWorkspace()
  const store = useEasyCode(client, workspace.directory)

  return (
    <>
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
    </>
  )
}
