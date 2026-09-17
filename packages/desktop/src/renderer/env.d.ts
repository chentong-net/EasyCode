/**
 * 预加载脚本注入到 window 上的桥接对象。
 *
 * 这里只声明类型，不做任何运行时代码：真正的注入发生在 preload 里。
 * 渲染层永远只通过 HTTP 接口与 Core 通信，这个对象只提供「连到哪里」。
 */
export interface EasyCodeBridge {
  /** Core 服务基础地址，例如 http://127.0.0.1:53421 */
  serverUrl: string
  /** 访问令牌 */
  serverToken: string
  /** 运行平台，取值同 Node 的 process.platform */
  platform: string
}

declare global {
  interface Window {
    /**
     * 由预加载脚本注入。
     *
     * 声明为可选：在浏览器里直接打开渲染层页面时它不存在，
     * 界面需要能识别这种情况并给出提示，而不是抛出一个类型上不可能出现的错误。
     */
    easycode?: EasyCodeBridge
  }
}
