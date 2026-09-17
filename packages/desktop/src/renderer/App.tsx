import { AssistantRuntimeProvider } from "@assistant-ui/react"
import type { EasyCodeClient } from "@easycode/client"

import { Chat } from "./Chat"
import { useEasyCodeRuntime } from "./runtime"
import { Sidebar } from "./Sidebar"
import { useEasyCode } from "./store"

/**
 * 应用外壳。
 *
 * 组装顺序上有两处依赖：运行时所需的会话状态来自 useEasyCode，
 * 而界面里的消息原语又必须在 AssistantRuntimeProvider 内部，
 * 因此两者都在这里挂载，子组件只消费结果。
 */
export const App = ({ client }: { client: EasyCodeClient }) => {
  const store = useEasyCode(client)
  const runtime = useEasyCodeRuntime(store)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="app">
        <Sidebar store={store} />
        <Chat store={store} />
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
