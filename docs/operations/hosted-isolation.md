# 同宿主 Claude 托管实例

独立数据目录必须配合宿主资源身份隔离。已有部署保持 `VM2API_INSTANCE_ID` 为空；新增托管实例配置稳定的实例名及不重叠的端口范围：

```dotenv
VM2API_INSTANCE_ID=hosted
VM2API_SUBSCRIPTION_PORT_RANGE=38000-39999
VM2API_EGRESS_PORT_RANGE=40000-55999
VM2API_CONTAINER_NAME=vm2api-hosted
VM2API_HOST_ROOT=/opt/vm2api-hosted
HOST=127.0.0.1
PORT=18888
VM2API_PANEL_COOKIE_NAME=kin_hosted_panel_token
VM2API_RELEASE_CHANNEL=hosted
KIN_AUTO_SYNC_WRAP=0
NODE_OPTIONS=--max-old-space-size=1024
```

实例名为 1–32 位小写字母、数字或连字符，首位必须是字母；不自动修剪、转小写或消除非法字符。具名实例未配置两个端口范围、端口越界、egress 范围不是完整偶/奇对、两个范围重叠时拒绝启动订阅管理器。为同宿主每个具名实例分配不同端口窗口；还应核验宿主其他服务实际监听。此例与旧订阅21000–22999、旧egress20000–35999不重叠。

不要在已部署的数据目录随意更改实例名或端口范围。名字决定槽容器、egress网络、bridge、iptables链身份。订阅恢复会检查每个已保存listener是否仍在配置窗口内，窗口变化不匹配时拒绝加载，不静默换端口或重新绑定线路。

构建前端时同时指定 `VITE_PANEL_COOKIE_NAME=kin_hosted_panel_token`，使同 IP 不同端口的其他实例登录 Cookie 保持独立。`VM2API_RELEASE_CHANNEL=hosted` 使更新页展示托管分支策略并阻止执行上游一键安装；托管版本通过已验证的 `dev/hosted` 镜像更新。

部署到其他入口时，可用构建参数 `VITE_GPT_CONSOLE_URL` 指定该实例的 GPT 控制台链接，避免页面跳到另一套部署。未配置时保留既有托管站点的链接。

## 一份共享契约

`src/lib/vm/instance-scope.mjs` 集中实现实例名、端口验证、资源命名和owner判断。函数接受env对象便于离线测试；调用者不应自行拼名或读取另一套namespace配置。

- 默认空实例保留 `kin-01`、`kin-eg-px-local`、原有bridge/chain/FNV端口算法；已有自定义 `runtime.container` 继续可用。
- 具名槽容器使用长度分隔的实例前缀，保留完整槽ID，避免 `vm-01` 与 `01` 或连字符边界互相覆盖。
- 具名egress network包含完整实例ID和proxyID；bridge/iptables链使用完整身份元组的SHA-256摘要后分别限制在15/27字符。截断前先hash，避免长ID共同前缀导致确定性碰撞。短系统名字不是授权凭据：Docker资源的完整instance/resource labels必须匹配，缺失或不同owner拒绝复用/操作；不得在冲突时回退旧 `px-local`。
- 每槽/代理保留原有独立HOME、数据目录、认证与出口guard。默认空实例的label对象为空，历史容器无需批量重建。
- Docker列表及本地槽内存统计按实例过滤。具名控制面不能通过已知容器ID停止、重启、删除、执行命令或读取另一实例/旧服务日志；Docker低层操作在发出mutation前检查owner。
- 具名实例的`runtime.container`必须等于由当前实例和槽ID派生的名字，不能直接信任从其他部署复制来的runtime指针。核心slot-exec、Rust supervisor和runtime均调用共享函数。
- 本地透明egress与集群每槽egress仍保留原有拓扑；远端容器/网络应使用明确slot/slot-egress/slot-network/proxy资源标签，而非仅检查名字前缀。

远端 SSH 用户目录在读取 host facts 时即隔离：具名实例使用 `$HOME/.vm2api/i/<instance>`，无名实例保持 `$HOME/.vm2api`。此 root 同时进入 ClusterManager 缓存、节点连接编辑校验、placement、凭据同步、payload 和 socket relay；不只修改某个槽位入口。macOS launchd 的 kernel/legacy telemetry 标签包含完整实例身份，具名实例拒绝来自其他实例的 runtime.remote_dir 或 launchd 标签。启停和清理不选择无名实例旧任务。长 HOME/实例名可能触及 macOS Unix socket 的103字节上限，原路径长度检查会明确拒绝，不能通过截断名字共享目录。

集群直连 gate 也使用实例专属容器名、gate resource label、root 和证书。多个实例在同一节点启用 gate 时必须分别配置不同监听端口；没有自动换端口或接管其他 gate。Darwin 实例的槽进程内存统计仅匹配对应root；宿主CPU、可用内存等仍表示整个节点的实际容量。

订阅profile个数不再固定限制为8；保留聚合512节点、每源解析限制、8MiB加密存储限制与listener窗口边界。第9个profile不会重新绑定已有节点、恢复禁用节点或改变原凭据。

## 部署与验收

使用独立Compose项目、控制面容器、`data/bin/share/vms/src/config`绑定目录与管理密钥。不要共享已有实例的 `.env`、DB、OAuth、HOME或订阅加密文件。宿主反代只新增独立入口并核验配置，不替换既有vhost。

推荐本轮Claude空槽：Docker、1 CPU、2GiB、显式并发1，每条线路一个容器；新网关内存2GiB、含Swap总限制2.5GiB。按实际线路数核算总资源。订阅先导入，逐线路双源确认出口并首次固定guard，再创建空槽。无Cookie时保持manual hold；已有固定出口漂移或检测失败不得自动rearm、换IP或退回直连。

验收应包含：

1. 旧服务容器ID/Image/StartedAt、端口、原有网络规则未变化。
2. 新实例所有槽/网络具备正确labels，px-local也属于新实例；每槽并发1与独立mount。
3. 查询新实例Docker列表不会列入旧服务，直接用旧容器ID执行stop/delete/exec/logs会被拒绝，且没有Docker mutation请求。
4. 订阅listener只在分配范围内；guard ready且无凭据槽不可派发。业务Key限定新Claude槽，max_concurrency=1。
5. 核验guest实际runtime/worker健康、实际固定出口及网络失败封闭；Cookie之后另做真实Claude JSON/SSE验收。

测试：`node --test test/unit/instance-scope.test.mjs test/unit/instance-docker-isolation.test.mjs test/unit/proxy-subscriptions.test.mjs`。Docker API隔离测试使用本机临时HTTP服务观察实际请求序列，不需要真实Docker或账号。egress helper执行测试依赖Linux ELF，应在Linux环境运行，不能把macOS的ENOEXEC当业务回归或通过。
