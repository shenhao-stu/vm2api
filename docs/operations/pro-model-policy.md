# Claude Pro 模型准入

Pro 槽及其下游账号只发布已验证的 Haiku、Sonnet、Opus 模型。不要发布任何 `claude-fable-*`，也不要把 Fable 请求映射到另一个模型后返回成功。

使用原生设置维护三层约束：

1. 主网关 `model_policy.catalog_mode=policy_only`，所有 Fable 条目 `enabled=false`，`defaults.enabled=false`。未知模型拒绝；原生目录同步会把新发现模型加入为禁用状态，不会重新打开已有禁用项。不要用“重置模型策略”覆盖生产策略。
2. 每个 Pro 槽通过 `PATCH /api/panel/vms/:id` 设置非空 `allowed_models`，内容为已启用的 Haiku、Sonnet、Opus 精确模型 ID。空数组表示不限制，不能当作“全部禁用”。保持原代理、并发和会话设置。
3. 对应 Sub2API Account 的原生 `credentials.model_mapping` 使用同样的非空白名单。检查映射键和值，禁止 Fable、指向 Fable 的别名，以及 `*`、`claude-*` 等宽匹配。不从模型目录直接全选导入。

新建共享或专属账号时，先保存以上限制再开放调度。每个 Sub2API Account 持有一把仅绑定对应 vm2api 槽的独立 Key；Sub2API 客户入口 Key 绑定的是分组，两者不是同一种凭据。账号可以加入多个共享分组，不能因此扩大 vm2api Key 的槽范围。专属亲和规则单独保留。

权益/额度探测也必须遵守模型开关和槽白名单；禁止通过手动“额度探测”绕过模型禁用。被跳过的探测不代表上游拒绝，不改变账号套餐判断；正常 `/usage` 采样与被动响应头计量仍可使用。

验收先使用离线 mock：检查禁用、白名单不匹配和未知模型均不产生 worker 请求，允许的探测路径仍可工作。生产仅发送已确认会在网关拒绝的新请求，核对 `attempt_count=0`，不要调用真实 Fable，也不要重放旧请求验证。正常模型可从自然业务记录核验。

删除封禁槽使用原生 API，撤销其独立 Key、删除对应 Sub2API Account，保留历史用量账本。共用的 Sub2API 入口 Key 和分组仍承载其他账号时不得连带删除。只停用明确属于该槽的自动恢复任务，不自动重绑凭据或解除出口锁存。
