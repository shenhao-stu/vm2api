# Clash / Mihomo 订阅

此分支将 Clash 与代理订阅合并为一个入口、一个加密 registry 和一个由网关管理的 Mihomo 进程。管理员在「代理 → 代理订阅」导入链接或粘贴 Clash YAML/JSON、Base64、协议链接。部署、存储与安全边界见 [代理订阅](PROXY_SUBSCRIPTIONS.md)，多实例端口隔离见 [托管隔离](operations/hosted-isolation.md)。

## 刷新与固定线路

新链接订阅默认每 360 分钟刷新，可暂停或设为 15–10080 分钟。调度与 URL 一起加密持久化，启动后处理到期任务，每分钟检查一次；失败 15 分钟后重试。旧版本未设置自动刷新字段的订阅保持关闭，粘贴内容无自动刷新。状态只返回名称、数量、时间和固定错误码，不回显 URL、节点凭据或供应商错误。

相同连接配置保持 ID、认证、端口与绑定；仅重命名不改变连接身份。运行配置相同且内核仍在运行时，不重载 Mihomo。自动与手动「刷新」均拒绝已绑定节点消失、凭据变化或解析 IP 变化，并保留整份旧配置。页面会显示原因。管理员审查后可「重新导入」指定订阅，变化的节点获得新 ID 与新端口，已绑定旧节点保留；该动作也不会让现有槽偷偷切换出口。固定出口 guard 的期望 IP 与锁存状态不由订阅刷新更改。

## 协议与 DNS

安全字段白名单支持 SS、SSR、VMess、VLESS、Trojan、Hysteria 1/2、TUIC、AnyTLS、Snell、Mieru、密码认证 SSH、单端点 WireGuard、SOCKS5 和 HTTP。非通用 URI 协议可使用 Clash YAML/JSON。配置必须通过字段验证与安装的 Mihomo 版本校验后才能应用；未知协议或字段报错，不静默降级。WireGuard 使用内联的固定长度密钥；不允许从文件载入 SSH/TLS 私钥、证书、任意插件、嵌套多 peer 端点或 dialer-proxy 绕过端点审查。

所有节点服务端先验证公网 DNS 再固定数字地址，保留 TLS SNI 和 WebSocket Host。供应商顶层 DNS、TUN、规则、控制器、监听器和 provider 均不执行。内核采用固定 Cloudflare/Google DoH 和公网 bootstrap 解析器，保留 HTTPS/type-65 查询供 ECH 使用；不会为 ECH 关闭证书校验。ECH 配置仅接受经过验证的字段。

字段与 DNS 语义参考 Mihomo 官方文档：[AnyTLS](https://wiki.metacubex.one/en/config/proxies/anytls/)、[SSH](https://wiki.metacubex.one/en/config/proxies/ssh/)、[WireGuard](https://wiki.metacubex.one/en/config/proxies/wg/)、[Hysteria](https://wiki.metacubex.one/en/config/proxies/hysteria/)。实际支持以本项目白名单及固定版本内核校验为准。

## API 与旧入口

推荐统一 API：

- `GET /api/panel/proxy-subscriptions`：脱敏状态。
- `POST /api/panel/proxy-subscriptions`：`{name,url|content,auto_refresh?,refresh_interval_minutes?}`；显式重新导入加 `id`。
- `POST /api/panel/proxy-subscriptions/:id/refresh`：保护已绑定线路的刷新。
- `PATCH /api/panel/proxy-subscriptions/:id`：`{auto_refresh?,refresh_interval_minutes?}`。
- `DELETE /api/panel/proxy-subscriptions/:id`：仅可删除没有绑定的订阅。

保留旧 `/api/panel/proxies/clash`，GET 返回 `configured/sources`；POST 接受旧 `yaml` 名称及 `action=import|refresh|configure`、`source_id`，转发同一 manager；导入/刷新保留旧 `added/updated/unchanged/retained_disabled/skipped/source` 响应字段，统计由公开的前后状态派生，不二次应用配置。`retained_disabled` 为兼容字段名，表示保留旧绑定节点数量，本实现不静默禁用其原线路。重复名称无法唯一选择订阅时必须提供 `source_id`。它使用相同管理员鉴权、字段验证、端口范围、固定出口与错误脱敏，不持有另一个 scheduler 或控制器。旧 source UUID 不会自动映射到新加密 registry 的 ID。

## 从 Fwind 独立 sidecar 迁移

源码 Docker 镜像已包含固定 Mihomo。兼容 `docker-compose.clash.yml` 只启用网关内核路径，不再创建 sidecar；`scripts/init-clash.mjs` 只检查部署，不写明文配置。

旧 Fwind 的 `data/clash/subscriptions.json` 可能含供应商 URL、节点凭据和旧监听认证。网关检测到该文件会拒绝初始化统一存储，避免两个 runtime 同时管理线路。迁移须在独立实例或维护窗口进行：保存受限备份、暂停旧自动刷新和依赖旧 listener 的槽、停止该实例的旧 sidecar，使用管理员 API 重新导入源，核对节点与固定出口后显式迁移绑定，再将旧明文目录移出数据目录到受限备份。旧明文文件不会自动读取或删除，旧端口与绑定也不会被悄悄接管。

迁移其他实例时不要停止同宿主的无关服务。新托管服务使用独立 HOME、数据目录、实例 ID 和端口范围，可与现役实例并存。
