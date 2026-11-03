# 代理订阅

管理员在「代理 → 添加 → 代理订阅」导入 HTTP(S) 订阅链接或粘贴 Clash YAML/JSON、Base64、协议链接列表。支持 Shadowsocks/SSR、VMess、VLESS、Trojan、Hysteria 1/2、TUIC、AnyTLS、Snell、Mieru、密码认证 SSH、单端点 WireGuard、SOCKS5 和 HTTP。重复节点按连接配置去重，名称变化不改变节点身份。未支持的字段和传输显式报错；导入失败不会把节点降级成另一种协议。

每个节点通过 Mihomo 生成一个独立的、需要随机认证信息的 `127.0.0.1` SOCKS5 入口，复用原代理池的绑定、启停和出口检查。节点名称显示在代理池中。当前入口只供控制面本机槽位使用，远端集群槽位的绑定和自动分配会拒绝。普通 SOCKS5 代理和原有集群功能不变。

新 URL 订阅默认每 360 分钟自动刷新，可暂停或设置 15–10080 分钟；失败 15 分钟后重试，重启补执行到期任务。旧订阅没有自动刷新字段时保持关闭。文本订阅的手动刷新重用已保存内容。相同配置不重载运行中的内核；节点名称变化不影响身份。自动与手动刷新发现已绑定节点消失、连接凭据变化或 DNS 地址变化时，整次拒绝并保留旧配置。管理员审查后可显式重新导入同一 `id`，变化的配置成为新节点，已绑定旧节点继续保留。监听端口单调分配，不交给另一节点。删除前必须解除全部绑定；单节点不能通过普通代理编辑/删除绕过订阅管理。详见 [Clash 与刷新](CLASH.md)。

## 部署

设置 `VM2API_MIHOMO_BIN` 为固定版本 Mihomo 的绝对路径。内核在网关所在的网络命名空间中运行；不发布订阅监听器或控制器端口。建议部署固定版本并校验官方发行包 SHA-256。Mihomo 是独立的 GPL-3.0 项目，来源与许可证见 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)。监听器认证及控制器接口配置依据 [Mihomo 官方文档](https://wiki.metacubex.one/en/config/inbound/listeners/socks/)。

源链接、文本和供应商节点凭据加密保存在数据目录的 `subscriptions/state.enc`，使用 AES-256-GCM。`VM2API_SUBSCRIPTION_KEY_FILE` 可指定独立的原始 32 字节密钥文件；否则首次运行在 `subscriptions/key` 生成。密钥文件权限必须为 `0600`，私有目录为 `0700`。备份与恢复必须同时保留对应密钥和密文，密钥宜独立保管。不能直接替换密钥后继续读取旧状态。现有代理池数据库仅保存本机入口认证，不存供应商节点凭据。

运行时配置文件为 `0600`，子进程不继承网关或宿主机的代理环境、凭据环境；原始内核输出不进入日志。配置先校验再应用，并验证每个本机监听器确实要求正确的认证。内核故障保持已绑定的 SOCKS5 路由；不会退回本地直连。配置文件丢失或无法解密时拒绝网关启动，避免丢失管理标记后误分配出口。内核退出后需显式刷新或重启服务恢复，不声明自动重启能力。

## 边界与 API

供应商顶层监听器、控制器、DNS、规则、provider 和脚本全部丢弃，只构造经过字段白名单检查的节点。源下载限制 2 MiB、20 秒与最多 5 次请求，每次重定向和连接前验证公网 DNS；HTTPS 不降级到 HTTP。节点端点只接受公网地址，解析后固定数字 IP，并保留原 TLS 服务器名。内核使用固定 Cloudflare/Google DoH 支持 ECH type-65 查询，不继承供应商 DNS；不会自动关闭证书校验。每次节点解析限 8 秒，最多 8 个并发；整个导入准备阶段限 45 秒。单订阅与总保留节点均最多 512 条，无 8 个订阅条数限制；默认监听范围为 21000–22999，可通过 `VM2API_SUBSCRIPTION_PORT_RANGE` 设置。具名实例须显式配置与其他实例不重叠的订阅及出口端口范围，详见 [多实例隔离](operations/hosted-isolation.md)。需要改变这些容量时应先检查已有状态与端口占用。

所有接口使用原有管理员会话或 master API key，普通用户、super 角色及普通客户端 API key 均无权限。响应设置 `Cache-Control: no-store`，不返回源 URL、源文本、原始节点和密码；失败只返回固定错误类型与消息。

- `GET /api/panel/proxy-subscriptions`：公开状态、订阅名称与节点到代理池 ID 的映射。
- `POST /api/panel/proxy-subscriptions`：`{"name":"名称","url":"来源"}` 或 `{"name":"名称","content":"配置文本"}`。两种来源互斥；可加 `auto_refresh` 与 `refresh_interval_minutes`，显式重新导入添加 `id`。
- `POST /api/panel/proxy-subscriptions/:id/refresh`：重新读取来源，保护已绑定线路；变化时保留旧配置。
- `PATCH /api/panel/proxy-subscriptions/:id`：设置 `auto_refresh` 与 `refresh_interval_minutes`。
- `DELETE /api/panel/proxy-subscriptions/:id`：删除未绑定的订阅及节点。

自动化导入时把请求 JSON 存入受限临时文件并使用 `curl --data-binary @FILE`，鉴权头同样通过受限配置文件提供。不要把源链接、节点密码或 API key 放在命令行、Git、日志或截图中。

## 公网部署

1. 将 `HOST=127.0.0.1`，设置独立端口。使用 TLS 反向代理对外服务；不要直接暴露控制面、Mihomo 控制器或 SOCKS 监听器。
2. 设置随机管理台密码、API key 和 DB secret；`.env` 设为 0600。一键安装会为缺失密码生成随机值，直接运行容器缺少密码则拒绝启动。
3. 使用 Cloudflare 时，在源站限制为 Cloudflare IP；只在这一可信边界内使用 `CF-Connecting-IP`，不要信任任意客户端转发头。登录接口配置较严格限流，普通 API 配置独立限流和连接上限。
4. 设置 `VM2API_DISABLE_TELEMETRY=1` 可强制关闭可选槽位/CLI遥测，覆盖显式重新初始化；必要的登录、额度查询和推理请求仍按功能发送。
5. 请求内容采集级别由服务端决定。客户端只能降低采集级别，失败鉴权凭据只保存 SHA-256 指纹。不要为公网实例开启不必要的 debug 内容日志。
6. 控制面持有 Docker socket 与网络管理能力，管理员等同于宿主高权限。只给可信管理员访问权；给控制面、槽位设置适合宿主容量的资源上限。


源码 Docker 构建自带固定 Mihomo v1.19.32 并校验 SHA-256。非 Docker 部署执行 `node scripts/fetch-mihomo.mjs /absolute/path/mihomo amd64`（ARM64 使用 `arm64`）下载同版程序。

内置数据库备份不包含订阅密文，请额外备份 `state.enc` 与匹配密钥并分开保管；Mihomo 的运行时明文配置不应上传到普通日志或备份。
