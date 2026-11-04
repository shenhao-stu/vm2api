# dev/hosted 整合说明

此分支面向独立 Claude 托管实例。整合基线为 shenhao-stu/main `2d76d801`、dofastted/main `177051ba` 和 Fwind43 的 `sync/upstream-v1.4.028` `b0dc96e2`（包含其 main）。比较以这些固定提交为准；源仓库以后前进不会改变本次报告的含义。

## 相对两个 main 的变化

| 领域 | 相对 dofastted/main | 相对 shenhao-stu/main |
| --- | --- | --- |
| 上游功能 | 保留当前协议、模型、账号、集群与原生 CLI 能力 | 同步新模型/Images、Responses WebSocket、原生 CLI/遥测契约、取消确认和 watchdog 恢复、工具/缓存/用量修正及当前 payload |
| 出口守卫 | 加入固定出口 IP、失败锁存、显式重新确认、guest 出口检查与源代码 helper 构建 | 保留原守卫并融合 Fwind 网段冲突检测、备用网段、独立出口熔断；不把代理故障当账号封禁 |
| 订阅 | 加入一套加密订阅管理器、认证本地 SOCKS、私有 Mihomo 与订阅 UI | 扩充安全协议支持、DoH/ECH、定时刷新及状态；取消 8 profile 硬限制，保留节点、存储和端口上界 |
| 线路身份 | 按配置 hash 识别节点；绑定后不因同名节点更新静默换线路 | 吸收 Fwind 刷新功能，但拒绝自动更新已绑定线路的凭据、地址或删除；无变化不重载 |
| 同宿主隔离 | 新增可选 instance scope，集中命名、owner 校验和端口分配 | 补齐槽容器、网络/bridge/iptables、远端根目录、运行状态和 Cookie 隔离；空 scope 兼容既有部署 |
| 调度与恢复 | 收紧未知派发结果的重试资格，补 reservation 前健康复核、预算及取消链路 | 同步新席位/队列/配额调度，修复旧健康缓存竞态；客户端取消及时释放等待，不增加上游执行 |
| 请求诊断 | 加入有界、脱敏的 hop timing 与失败阶段记录 | 保留真实 SSE 业务错误过滤；attempt 序号与实际执行预算分离，保留失败过程的真实 usage |
| UI | 列表、机架、统计和详情共享 readiness 判断；显示阻塞原因和下一步动作 | 删除 ReClaude 入口，合并重复订阅界面；运行中不等于可接单，明确 Pro 不被残留 Fable 探测升级成 Max |
| 发布 | 增加 hosted 独立 Compose、反代例子、Cookie 和分支镜像工作流 | hosted 更新通道固定，不允许面板执行上游 main 安装器；不改现役 main 发布方式 |
| ReClaude | 不引入此集成 | 删除 native relay 实现、路由、UI、专属测试和文档；保留通用 SSE/取消/核算改进 |

能力盘点按 `src/lib` 全部一级模块、所有 Web feature 以及分叉独有变更逐项核对。这里的整合指受支持功能的统一实现，不承诺接纳任意 Mihomo 配置、插件、文件凭据或已淘汰实现。Fwind 的明文订阅仓库与 sidecar 被一套加密 manager/runtime 替代，旧 Clash API 是薄兼容层，不拥有第二套存储或后台刷新。

## 调度不变量

- 只有传输层确认 `upstreamExecutions=0` 且 `committed=false`，未知网络/超时错误才允许自动恢复。尚未收到客户端内容不等于未发生上游执行。
- HTTP 200 空输出、仅 thinking 或执行结果不明时，返回真实错误并保留已知用量，不自动再生成。纯前置 400/429 拒绝可在预算内恢复；已带生成用量则停止。
- 候选槽在 reservation 前重新检查健康与暂停条件；并发 lease 必须在所有终止路径释放。
- 请求剩余预算约束首次和后续健康探测。显式耗尽预算不能借健康缓存继续派发；忙槽等待响应取消信号。
- 托管配置中每槽显式并发 1，默认/Pro 配额并发 1，业务 Key 也为 1。Key 的 1 是该 Key 所有授权槽合计 1。
- OAuth 的 `count_tokens` 返回明确 `400 count_tokens_unsupported`，引导使用 `/v1/usage`；Setup Token / Console API Key 保留原生 token 计数。不会用额度百分比冒充 token 计数成功。

## 结构与审查取舍

资源身份与端口计算集中在纯函数模块 `instance-scope.mjs`；状态展示由同一套派生函数服务多个 UI 视图。订阅解析、持久化、runtime 和 HTTP adapter 各有单一责任；不为兼容旧 API 再建状态库。出口熔断与账号额度分开，重试资格独立于重试次数，关键边界写入检查和行为测试。

验证覆盖实际 Unix socket 上“收到 POST 后断开只执行一次”、取消等待、预算耗尽、并发 1 排队释放、跨实例 Docker owner 拒绝、订阅绑定线路刷新保护以及协议用量/鉴权。Linux ELF、`/proc` 和部署脚本必须在 Linux 上另验，macOS 无法执行不算通过。实际部署验收及测试结果以每次发布记录为准，本文不声明尚未执行的 CI 或镜像发布已成功。

部署与后续账号验收见 [实例隔离](hosted-isolation.md)、[镜像构建](../DOCKER_IMAGE.md) 和 [订阅管理](../PROXY_SUBSCRIPTIONS.md)。没有 Cookie 的槽可以运行并验证网络，但不能宣称 Claude 推理已可用；导入账号后仍需检查实际套餐、模型权限、JSON/SSE 和用量，再解除人工停调。

## 统一 GPT / Claude 托管

托管实例交付 GPT / Claude 两把独立 Key，统一控制台、API 入口和日志。GPT Key 使用内部 `hybrid` 网关能力与 `group_type=openai`，明确绑定一个 `local_gateway` 端点，不授权任何原生 Claude 槽；Claude Key 使用原生 `oauth` / `anthropic` 及明确槽范围。两把 Key 分别限制并发 1，并在派发前拒绝跨平台调用。旧混合 Key 的兼容读取仍保留，但此实例不再提供混合 Key。GPT 账号仍由已部署的 GPT 后端管理，避免复制账号、刷新凭证和调度状态。端点只接受数字 loopback origin、明确 GPT 模型和 Bearer 认证；不接受代理、重定向或自定义头，不进入普通 API 调度。

GPT 上游统一使用 Responses；纯转换函数适配 Chat、Completions 与 Messages，原生 Responses 保留完整结构。JSON/SSE 校验终态、可见内容和真实终量；补齐 completed-only 文本时校验已发前缀，工具身份变化明确失败，不重复生成。GPT Messages 支持文本和标准工具，其他块明确拒绝并引导原生 Responses；Claude 保留原生完整链路。普通 Python/curl 可以通过部署的 `claude_code_only=false` 调用，网关沿原生 Claude Code 传输，无需客户端伪造 CLI 头。

JEV 支持卡密文本/文件导入、去重预览和行号报错，临时邮箱字段不会混入 Key。401 退休、429 单 Key 冷却、529 站点冷却，遵守 Retry-After；整体审核受一个总超时和取消信号约束。无效/缺失评分不再当成零分封禁，实际提出的问题必须有合法评分；审核不可用时按 fail-open 配置处理。托管实例使用 fail-closed。

所有 Fable 系列在托管入口禁止调用，大小写与别名解析后的模型均检查，目录也不暴露 Fable。模型测试仅使用允许的 Haiku 与 GPT 模型，不向 Fable 上游派发。

固定出口保护在网关重启后要求显式确认原 IP。手动启动/恢复槽只有在同一代理绑定、最新出口验证和推理内核均健康时，才解除该代理留下的冷却标记；人工停调、凭据保护和其他原因的停用继续保留。后台探测不会替代此显式恢复。
