import type { EasyCodeClient } from "@easycode/client"
import { useEffect, useState } from "react"

import { Chat } from "./Chat"
import { SettingsDialog } from "./Settings"
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
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void client.config
      .get(controller.signal)
      .then((config) => {
        if (!controller.signal.aborted && !config.modelConfigured) setSettingsOpen(true)
      })
      .catch(() => {
        // 配置读取失败会由设置页在打开时展示具体原因。
      })
    return () => controller.abort()
  }, [client])

  return (
    <>
      <div className="app">
        <div className="app-body">
          <Sidebar store={store} workspace={workspace} onOpenSettings={() => setSettingsOpen(true)} />
          <Chat store={store} workspace={workspace} />
        </div>
      </div>

      <SettingsDialog client={client} open={settingsOpen} onClose={() => setSettingsOpen(false)} />

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
