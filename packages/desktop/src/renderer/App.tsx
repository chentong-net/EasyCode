import type { EasyCodeClient } from "@easycode/client"

import { Chat } from "./Chat"
import { Sidebar } from "./Sidebar"
import { useEasyCode } from "./store"
import { useWorkspaces } from "./workspace"

/**
 * 应用外壳。
 *
 * 会话状态来自 useEasyCode，子组件直接消费领域消息和操作，不再经过额外的
 * UI runtime 适配层。
 *
 * 窗口标题栏由左右两侧的顶部区域共同承担，避免在主界面之外再占一条独立横栏。
 * 侧边栏顶部同时要给 macOS 左上角的红绿灯按钮留出空间。
 */
export const App = ({ client }: { client: EasyCodeClient }) => {
  const workspace = useWorkspaces(client)
  const store = useEasyCode(client, workspace.directory)
  const error = store.error ?? workspace.error

  return (
    <>
      <div className="app">
        <div className="app-body">
          <Sidebar store={store} workspace={workspace} />
          <Chat store={store} workspace={workspace} />
        </div>
      </div>

      {error !== undefined && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              store.clearError()
              workspace.clearError()
            }}
          >
            知道了
          </button>
        </div>
      )}
    </>
  )
}
