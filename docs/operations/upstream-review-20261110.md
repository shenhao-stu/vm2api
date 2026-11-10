# 上游 PR 增量审查 — 2026-11-10

以 GitHub API 14:33 北京时间快照和逐文件 diff 为准；网页缓存的“开放中”列表可能滞后。最近15个PR中13个已合入，936/939为关闭未合入。审查不等于批准切换线上内核。

| PR | 结论与处理 |
|---|---|
| [951](https://github.com/dofastted/vm2api/pull/951) | 显式 OAuth subscription_type/rate_limit_tier、账号更换和异步写回隔离已在本轮选择吸收；保留我们额外的Ultra、活动截止、U134、拒绝会话保护。不能用Fable用量/调用成功推断MAX。 |
| [948](https://github.com/dofastted/vm2api/pull/948) | 确认当前Codex转换会静默丢掉Anthropic source图片。增加4个上游行为测试，3个先失败；只移植7行imageUrlOf转换，23项全绿。仅源码候选，不重启独立Codex或Claude。 |
| [949](https://github.com/dofastted/vm2api/pull/949) | codex-auto-review固定映射Luna属于产品路由选择，不是通用错误修复。未覆盖线上模型映射/统一Key/质量静置策略。 |
| [943](https://github.com/dofastted/vm2api/pull/943) | 67文件包含CRAG授权/身份/telemetry/安装与协议变化，不能整体cherry-pick。Fable元数据已选择吸收；我们依官方规范保留high effort及enabled→adaptive，未照搬其medium/passthrough。既有ReClaude历史/工具/幂等不替换。 |
| [947](https://github.com/dofastted/vm2api/pull/947) | 捆绑CLI2.1.321；未应用，符合用户保持线上CLI/内核要求。本机CLI升级不授权生产升级。 |
| [946](https://github.com/dofastted/vm2api/pull/946) | AppArmor unconfined放宽guest挂载权限；当前未遇到对应CRAG挂载故障，不扩大安全权限。 |
| [942](https://github.com/dofastted/vm2api/pull/942)、[941](https://github.com/dofastted/vm2api/pull/941)、[938](https://github.com/dofastted/vm2api/pull/938)、[945](https://github.com/dofastted/vm2api/pull/945) | CRAG v2授权/安装/选槽，当前仍原生稳定内核，推迟；不能借升级自动重建/重启槽。 |
| [944](https://github.com/dofastted/vm2api/pull/944) | 内核徽章展示，不覆盖已验收的统一Claude/ReClaude/Codex控制台。 |
| [934](https://github.com/dofastted/vm2api/pull/934) | 准备集群镜像的cc-node回退；当前17份核心指纹和稳定镜像基线保持，未出现该安装失败，不引入另一套自动回退。 |

额外实证：34038全链路控制发生worker502后，空池被无条件写成fable_requires_max。已复现并小改为只有真实套餐拒绝才返回套餐错误，保留Pro活动门槛；冷却/尝试耗尽保留实际原因。候选216项回归通过，未加载生产网关，不能以此宣称网络502已修复。

证据：latest-refreshed.safe.json、各PR文件diff、948-red/green.log；../scheduler-cause-red.log、../latest-pr-regression.log。无生产CLI/内核/遥测/出口策略变化，没有重放任何旧客户请求。
