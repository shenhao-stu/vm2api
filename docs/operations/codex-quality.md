# Codex 答题质量探测

独立 Codex 控制器可通过 `VM2API_CODEX_QUALITY=1` 启用管理员探测面板。初始模式为手动。管理员可在 VM 页选择每小时或每天，每轮串行处理到期的空闲账号。账号忙碌时延后到下一个空闲检查点。

在控制器的持久化数据目录创建 `codex-quality-exits.json`，按槽填写已经核验过的 SOCKS 入口和固定出口，例如：

```json
{
  "codex-example": {
    "proxy_id": "example-proxy",
    "host": "127.0.0.1",
    "port": 1080,
    "ip": "192.0.2.10"
  }
}
```

探测前通过绑定的 SOCKS 链路向两家 HTTPS 服务核实出口。固定绑定缺失、出口变化或检测失败均跳过模型调用。探测使用独立会话和请求 ID，最多 512 个输出 token。只有该槽一次派发的完整响应、模型归属和账本都吻合才判分。答对清除错题计数，两次有效答错使该槽静置 24 小时。恢复需要间隔 10 分钟的两次正确答案。人工停用、凭据异常及出口保护优先。

`GET /api/panel/quality-probe` 返回上次结果、请求 ID、错题数及恢复时间。`PUT` 可设置 `mode` 为 `manual`、`hourly` 或 `daily`。`POST /api/panel/quality-probe/run` 发起一次管理员探测，占用套餐额度；在自动模式下遵守每个账号的间隔。该题观察的是指定模型对一个可验证问题的表现。
