# ReClaude 缓存顺序修复与出口切换 — 2026-10-31

本轮修复已上线，Sub2API 33871 恢复共享调度；并发10，保留 Sonnet/Haiku/Opus 5.5 和 Fable 5.1。仅按用户本次明确许可，将独立 ReClaude 出口从149.119.169.119切到64.51.37.130并重新锁定。主网关和9个Pro槽均未重启，原账号、Key、固定出口、并发1、U134专属隔离和Fable禁用未改变。

## 报错根因与修复

13:20的 Fable 请求先被上游拒绝：Sub管理台测试在用户消息中加入默认5分钟缓存标记，适配器将其传入原生CLI；CLI随后加入1小时缓存块，违反长TTL必须在短TTL之前的顺序。CLI尝试自动纠正重发，被现有单次派发保护正确阻止，最终呈现 `native_request_consumed_no_replay`。不是用户重复点击，也没有证据指向出口或OAuth撤销。

修复在CLI输入边界统一去掉调用方的缓存注解，由原生CLI管理缓存。初次消息、后续消息、tool_result使用同一纯转换；工具参数或schema中名为cache_control的业务数据保留，输入对象不被修改。保留单次派发保护，不重放失败请求，不用强制5分钟缓存覆盖原生策略。

同时使用原生 `ENABLE_CLAUDEAI_MCP_SERVERS=false` 关闭Relay不需要的个人Claude.ai云端连接器。调用方显式MCP工具、原生授权、策略检查、真实遥测保留。实际CLI断网工具/历史测试通过。

证据：`consumed-debug-evidence.safe.json`、`consumed-cache-red.safe.json`、`consumed-cache-green.safe.json`、`consumed-linux-regression.safe.json`、`consumed-history-regression.safe.json`。本机和Linux各100项回归通过；实际CLI缓存错误红→绿、四模型、工具和历史均在断网fixture验证。

## 唯一一次真实验收

用户明确允许1次全新Fable5.1流式验收，预算0.30、最多1024输出token，失败不重试。13:43通过Sub原生管理员账号测试到vm2api→AgentNAS原生ReClaude→官方上游，完整流式响应为普通问候，正常 `end_turn`，1次派发、1个终帧、HTTP EOF，无重试。未重放原13:20失败请求。

| 项目 | 实测 |
|---|---|
| Sub管理员请求 | 8e18a19d-bf50-4574-aa14-94c50bd1f124 |
| vm2api请求 | 15bfd155-976f-4087-b8b6-8705e00563ef；200/verified/1 attempt |
| 官方记录 | 356029608；device53966 / org424032 |
| 用量 | input2、output13、cache1h3896、cache-read649、cache5m0 |
| 计量 | 官方、CLI、vm2api一致：0.07875225 |
| 官方额度 | 0.0316884 → 0.11044065；增量恰好0.07875225 |
| 耗时 | 端到端12.452秒；官方生成1.426秒 |

Sub原生管理员连接测试本来不走客户消费账本，因此本次没有下游用户扣款；不能把它称为新增客户计费验收，也不能据此补扣客户。官方 `deduction_status=not_charged` 指套餐记录，不代表额度未消耗。三层逐token及费用核对见 `consumed-reconciliation.safe.json`。

验收期间单独给ReClaude HTTP worker加原生CLI预算0.30；验收后恢复原unit，未将临时预算强加到客户会话。Sub仅33871短暂停调，13:46:20恢复；不是ReClaude全程零中断。

## 出口、隔离与性能

当前guard revision为 `6e194e5c-485e-4f8d-9a49-b6732c399ff6`。Happy独立kin-egress、SSH回环转发目标、管理侧车及NAS agent的允许IP同步更新。实际容器内两个HTTPS源均为64.51.37.130，官方设备页亦记录该IP；原生53966、daemon1974及container启动时间保持，没有重新绑定OAuth。下次异常或重启锁存仍需人工审查，不能沿用本次许可自动解锁或接受别的IP。

防火墙实际规则和策略未变：TCP与TCP/UDP DNS导入独立helper，桥接外发DROP；无公网发布端口、cap-drop ALL、只读rootfs、非privileged。Docker网络不启用IPv6，namespace仅有::1且无IPv6路由，IPv6负控连接失败。不是只凭出口地址推断所有网络安全。证据 `consumed-egress-security.safe.json`、`consumed-network-routes.safe.json`、`consumed-protection-checks.safe.json`。

无模型输入的原生准备测试：关闭云连接器前7.469秒/12个元数据请求，后5.026秒/8个；两次均策略就绪、0模型派发。切换前小样本新路径HTTPS中位2.418秒、旧3.285秒；正式守卫路径上线后3次中位3.510秒，尚未证明新IP有稳定时延收益。真实请求约8.3秒仍用于CLI准备，其余包含模型和传输；不能用不同模型/冷热缓存样本宣称整体提升。保留同一会话原生CLI复用，不跨用户预热共享上下文。

## 运行与继续维护

源码位于 `codex/reclaude-agentnas-20261031`。生产仅替换NAS `work/native-http-19/native_bridge_session.py`，SHA `f128617211d2a0fe53a00de44a4a136299358be71579cd3e65618c6ec73faa73`。HTTP恢复后的unit SHA `72fdc89fa8aee9276ce8800874c498edb23e61463aa1123718fec15e96fe7978`。

Happy备份/本次意图在 `/opt/vm2api-reclaude-agentnas-20261031/cache-exit-release-20261031`；NAS在 `/home/ozer.guest/.vm2api/reclaude-agentnas-runtime-20261031/work/native-http-19/cache-exit-release-20261031`。备份仅供受控源码/配置回退，禁止回灌OAuth、会话、账本、guard state；切回旧IP也需要新的明确许可。所有本次once/intent已消费，不再执行这些发布、切换、恢复、付费脚本。

原始症状修复与短窗验收成立，不承诺永久不解绑、所有Messages参数兼容或并发10峰值容量。既有真实CLI后端的兼容边界和此前未补计的旧请求保持原交接说明。最终保护、资源、日志和发布检查见 运维项目的 `work/reclaude-agentnas-20261031/CONSUMED-MONITOR.md`；继续工作先读该目录 `HANDOFF-current.md`。
