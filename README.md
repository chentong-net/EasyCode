# EasyCode

EasyCode 在本地机器上运行，通过 OpenAI 兼容协议调用模型，在指定的工作目录内读写文件、检索内容、执行命令。入口有两个：命令行与 Electron 桌面端，两者共用同一套 Core 运行时。

## 包结构

| 包 | 职责 | 上游依赖 |
| --- | --- | --- |
| `@easycode/schema` | 语义值：会话、消息、事件、工具、权限、用量 | — |
| `@easycode/protocol` | 接口契约：端点常量、请求与响应 DTO、错误分类 | schema |
| `@easycode/core` | Agent 运行时：回合循环、上下文组装、工具执行、权限判定、事件日志 | schema |
| `@easycode/server` | 把 Core 绑定到 HTTP 与 SSE | core、protocol |
| `@easycode/client` | TypeScript 客户端，供界面调用 HTTP 接口 | protocol |
| `@easycode/cli` | 命令行入口 | core、server、protocol、schema |
| `@easycode/desktop` | Electron 外壳、本地 sidecar 与渲染层 | core、server、client、protocol、schema |

依赖方向单向：`schema → core → server`。`client` 以 `protocol` 为契约来源；`cli` 与 `desktop` 通过 `server` 暴露的接口访问运行时。这套方向由各包的依赖表约束：`core` 的依赖项为 `schema`、`glob`、`zod`、`zod-to-json-schema`，`client` 的依赖项为 `protocol`、`schema`、`zod`，界面相关依赖集中在 `desktop`。

## 源码目录

```
packages/
  schema/src/        语义值定义
  protocol/src/      接口契约
  core/src/
    llm/             OpenAI 兼容协议的报文编解码与流式解析
    session/         事件日志、投影、上下文组装、历史压缩
    tool/            工具定义、内置工具、路径解析与目录边界
    permission/      权限规则求值
    runner/          回合循环
  server/src/        HTTP 路由与 SSE
  client/src/        类型化客户端
  cli/src/           命令行
  desktop/src/
    main/            主进程：窗口、sidecar 启动、系统目录选择
    preload/         预加载脚本：向渲染层注入运行环境信息
    renderer/        React 消息界面与 Markdown 渲染
    sidecar/         Core 服务进程
    shared/          主进程与预加载脚本共用的常量与类型
```

## 环境要求

- Node.js 20 或更高版本（见根 `package.json` 的 `engines` 字段）
- npm（依赖以 workspaces 方式安装）

## 安装与配置

```bash
npm install
cp .env.example .env
```

`.env` 位于仓库根目录，由 `.gitignore` 排除。Core 读取以下变量（环境变量优先级高于 `.env`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容协议的接口地址 |
| `OPENAI_API_KEY` | 必填 | 接口密钥 |
| `OPENAI_MODEL` | 必填 | 模型 id，会话创建后保持固定 |
| `OPENAI_MODEL_CONTEXT_WINDOW` | `128000` | 上下文窗口大小，压缩阈值据此计算 |
| `OPENAI_MAX_OUTPUT_TOKENS` | `8192` | 单轮回复的输出预算，参与上下文计算 |
| `OPENAI_TEMPERATURE` | 空 | 采样温度；留空时请求体省略该字段 |
| `OPENAI_EXTRA_HEADERS` | 空 | 附加请求头，格式为 `KEY1=VALUE1,KEY2=VALUE2` |
| `EASYCODE_DATA_DIR` | `~/easycode/.easycode` | 会话日志、上下文快照与工具输出的存放目录，支持 `~` |
| `EASYCODE_LOG_LEVEL` | `info` | 取值 `debug` / `info` / `warn` / `error`；日志写入 stderr，设置 `EASYCODE_LOG_FILE` 时同时落盘 |
| `EASYCODE_ENV_FILE` | 空 | 显式指定配置文件路径，优先级高于工作目录下的 `.env` |

密钥只在 Core 进程内使用，渲染进程通过 HTTP 接口获取会话数据。

## 构建与检查

```bash
npm run build       # 按依赖顺序构建全部包
npm run typecheck   # 各包执行 tsc --noEmit
npm run clean       # 清理 dist 与 release 目录
```

## 命令行

```bash
npm run build

# 在工作目录下执行一次任务
node packages/cli/dist/index.js run "统计 src 下的 TypeScript 文件数量" --dir ~/easycode

# 列出全部会话
node packages/cli/dist/index.js sessions

# 启动本地 HTTP 服务，供界面连接
node packages/cli/dist/index.js serve --port 8080
```

| 命令 | 用途 |
| --- | --- |
| `run "<要求>"` | 在工作目录下执行一次任务，过程与结果输出到终端 |
| `sessions` | 列出全部会话（id、标题、更新时间、工作目录） |
| `serve` | 启动本地 HTTP 服务 |

| 选项 | 适用命令 | 说明 |
| --- | --- | --- |
| `--dir <目录>` | `run` | 工作目录，默认 `~/easycode` |
| `--session <ID>` | `run` | 复用已有会话，省略时新建 |
| `--reasoning` | `run` | 输出模型的推理过程 |
| `--port <端口>` | `serve` | 监听端口，默认由系统分配空闲端口 |
| `--token <令牌>` | `serve` | 访问令牌，默认随机生成 |
| `--no-token` | `serve` | 关闭鉴权，供本机调试使用 |

`serve` 会把服务地址与访问令牌打印到终端，接口调用示例：

```bash
curl -H "x-easycode-token: <令牌>" http://127.0.0.1:8080/api/health
```

`packages/cli` 注册了名为 `easycode` 的 bin，执行 `npm link` 之后可以直接使用该命令。

## 桌面端

```bash
npm run build
npm start --workspace @easycode/desktop
```

打包安装包：

```bash
npm run package --workspace @easycode/desktop
```

产物写入 `packages/desktop/release`，macOS 目标为 dmg，Windows 目标为 nsis，Linux 目标为 AppImage。

进程结构：

| 进程 | 职责 |
| --- | --- |
| 主进程 | 创建窗口、拉起 sidecar、把服务地址与访问令牌注入预加载脚本、提供系统目录选择 |
| 预加载脚本 | 通过 `contextBridge` 暴露 `serverUrl`、`serverToken`、`platform`、`homeDirectory`、`selectDirectory` |
| 渲染进程 | 自有 React 消息界面，经 HTTP 与 SSE 读取 Core 状态 |
| sidecar | 由 `utilityProcess` 拉起，内部加载 Core 并在回环地址上启动 HTTP 服务，就绪后把地址写入握手文件 |

服务端口由系统分配，地址与令牌经预加载脚本单向注入渲染层；渲染层调用主进程的能力为系统目录选择一项，会话、消息、工具调用均经 HTTP 接口完成。窗口标题栏由界面自绘，macOS 上以 `titleBarStyle: hidden` 隐藏系统标题栏，并按平台为左上角的窗口按钮留出位置。

## 运行机制

### 回合循环

一次回合按以下顺序推进：

1. 用户输入在回合开始前写入事件日志
2. Runner 为用户输入建立任务契约和显式阶段状态
3. 组装任务记忆、历史上下文和工具定义并调用模型
4. 模型产出的工具调用先写入事件日志，再按顺序交给工具执行
5. 工具结果更新修改文件、验证状态、失败观察和重复调用计数
6. 全部工具调用结算完成之后，判断是否进入下一个 provider turn
7. 代码修改后若尚未验证，Runner 进入验证阶段并要求模型补做验证或说明无法验证
8. 回合结束前写入结构化任务结果，再写入空闲事件

任务状态通过 `task.updated` 事件持久化，包含目标、验收条件、阶段、修改文件、验证结果和最终结果。它独立于普通消息历史，压缩对话上下文时仍会注入模型请求尾部。

### 事件日志与投影

每个会话对应一份 append-only 的 `events.jsonl`，它是状态的唯一真相来源；消息列表与界面展示由 `applyEvent` 投影得到，同一份日志重放所得结果一致。事件分两类：带 `seq` 的持久化事件可通过 `after` 参数补发；`text.delta` 这类瞬时事件经 SSE 推送，用于展示生成过程。

### 上下文组装与压缩

系统提示词在一个上下文纪元（epoch）内逐字节保持一致，工作目录等动态信息从消息流尾部追加，以提升 prompt 缓存命中率。

压缩预算根据上下文窗口动态推导，不再使用固定 20K 缓冲区和 8K 保留区。Runner 会为输出、安全余量和最近完整对话交换分别计算空间，并在上下文达到软阈值时自动压缩。

摘要使用结构化工作记忆模板，保留目标、限制、决定、完成状态、阻塞、下一步、关键文件和验证结果。最近历史按完整用户交换保留，不包含旧推理文本。摘要输入超过预算时会分块摘要再合并；模型摘要失败、超时或输出被截断时，会生成确定性降级检查点，而不是直接放弃压缩。

provider 报告上下文超限时，Runner 会重新投影历史、重建请求并按比例缩小保留区后重试。压缩结果会记录触发原因、前后预算估算、尝试次数和是否降级。

### 权限

规则形如 `{ action, resource, effect }`，按顺序求值并取最后一条同时匹配 `action` 与 `resource` 的规则，`effect` 取值为 `allow` / `ask` / `deny`，默认效果为 `ask`。一次调用涉及多个资源时取最严格的结果。

内置 `build` agent 的规则集：默认允许；访问工作目录之外的路径、读取 `.env` 与 `.env.*` 文件、执行含 `rm -rf` 或 `sudo` 的命令需要用户确认。用户在界面上选择「总是允许」后，该决定保存为优先级更高的规则。

### 内置工具

| 工具 | 用途 |
| --- | --- |
| `read` | 按行范围读取文件 |
| `glob` | 按文件名模式查找文件 |
| `grep` | 按正则表达式检索文件内容 |
| `edit` | 精确替换文件片段 |
| `write` | 创建或整体重写文件 |
| `bash` | 在工作目录下执行命令 |
| `todowrite` | 维护任务清单 |
| `question` | 在歧义或实现取舍影响任务方向时请求用户确认 |

`glob` 与 `grep` 默认跳过 `node_modules`、`.git`、`dist` 等目录，`grep` 另外跳过二进制文件与超过 2MB 的文件。超长工具输出写入 `<EASYCODE_DATA_DIR>/tool-output/`，消息中保留落盘路径。

工具结算包含结构化元数据：副作用类型、失败原因、是否可重试、修改文件路径和验证结果。`bash` 的非零退出码与超时会作为失败返回；测试、类型检查、构建和 lint 类命令会作为验证证据更新任务状态。文件编辑与整体写入使用同目录临时文件加原子替换。

## HTTP 接口

接口前缀为 `/api`，监听回环地址。配置了访问令牌时，请求需携带 `x-easycode-token` 头。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 服务状态、协议版本、模型 id、上下文窗口与输出预算 |
| GET | `/api/agents` | 可用 agent 列表 |
| GET | `/api/sessions` | 会话列表 |
| POST | `/api/sessions` | 创建会话，请求体为 `{ directory, title? }` |
| GET | `/api/sessions/{id}` | 会话详情 |
| GET | `/api/sessions/{id}/messages` | 消息列表（事件日志的投影结果） |
| POST | `/api/sessions/{id}/prompt` | 提交用户输入，请求体为 `{ text, delivery? }` |
| POST | `/api/sessions/{id}/interrupt` | 中断当前回合 |
| GET | `/api/sessions/{id}/events` | 事件流（SSE，`after` 参数指定起始 `seq`） |
| GET | `/api/sessions/{id}/permissions` | 待审批的权限请求 |
| POST | `/api/sessions/{id}/permissions/{requestID}/reply` | 回应权限请求，请求体为 `{ reply, feedback? }` |

`prompt` 返回 `{ inputID }` 后立即结束，执行进度经事件流反馈。

## 数据目录

```
<EASYCODE_DATA_DIR>/
  sessions/<会话ID>/session.json    会话元信息
  sessions/<会话ID>/events.jsonl    持久化事件，append-only
  sessions/<会话ID>/context.json    上下文纪元状态
  compaction-contexts/<会话ID>/     压缩前后的完整请求与摘要诊断
  tool-output/tool_*.txt            超长工具输出的落盘文件
```

`session.json` 是事件日志的派生缓存，供会话列表读取；它结构不符时，会话由事件日志重新推导。

每次真正开始上下文压缩时，还会在
`<EASYCODE_DATA_DIR>/compaction-contexts/<会话ID>/` 下创建独立诊断目录：

- `before.json`：触发压缩前准备发送给主模型的完整请求；
- `after.json`：新上下文纪元建立后，真正准备发送给主模型的完整请求；
- `summaries/`：摘要模型每次调用的完整输入、结束原因、usage 和模板校验结果，失败或中间分块会保留原始摘要文本；
- `metadata.json`：触发原因、预算、压缩前后估算、保留消息、摘要尝试次数和是否降级。

诊断文件不包含 API Key 等鉴权信息，使用仅当前用户可读的文件权限。备份失败只记录警告，不会中断主任务。

## 当前实现范围

- 单个内置 agent：`build`，单轮任务上限 30 步
- 模型在 `.env` 中配置，会话内保持一致
- 八个内置工具，覆盖读代码、找代码、改代码、跑验证、管进度和必要澄清
- 多会话：会话创建时绑定工作目录，之后保持绑定
- 两种入口：命令行与 Electron 桌面端，共用 Core 运行时
- 事件流断线重连，按 `seq` 补发缺失事件
- 回合具有显式任务阶段、验证门槛、无进展保护和结构化最终结果
- 上下文用量超过阈值时自动压缩，支持分块摘要、预算收缩和确定性降级
