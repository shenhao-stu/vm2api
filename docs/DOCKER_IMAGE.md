# 托管镜像构建与部署

代码来源为 `shenhao-stu/vm2api` 的 `dev/hosted`。保留 Fwind43 的双架构构建及启动验证流程，但托管包独立使用 `ghcr.io/shenhao-stu/vm2api-hosted`，不更新原 vm2api 的镜像标签。工作流只允许在 `dev/hosted` 发布，默认标签 `hosted`，并生成提交标签；镜像完成验证后才发布。

`.github/workflows/docker-image.yml` 支持 `workflow_dispatch`。GitHub Actions 必须对该仓库启用并识别该工作流；本分支存在配置不等于已成功发布镜像。查看工作流实际结果后再使用其输出的 digest。需要默认分支登记工作流时，不应为此自动修改受保护的 main。

本地或服务器构建 AMD64 镜像：

```sh
docker build --build-arg VITE_PANEL_COOKIE_NAME=kin_hosted_panel_token \
  -t vm2api-hosted:<已验证提交> .
```

控制面、Web、Go helpers 从当前源码构建，provider kernel 与 CLI 使用 `deploy/payload.json` 的版本、大小和 SHA-256 校验。源码编译的 worker、egress、slot-gate 最后覆盖镜像内同名 payload，保留固定出口守卫。ARM64 的单独 Dockerfile 保留原生控制面/CLI及固定 AMD64 payload 支持；是否通过该架构验收应以对应构建记录为准。

运行目录使用独立的 `data/bin/share/vms/src/config` 和 0600 的 `.env`。将 `deploy/hosted.compose.yml` 复制为该目录的 `compose.yml`，`.env` 的 `VM2API_IMAGE` 填完整已验证镜像标签或 digest；配置字段见 [hosted-isolation.md](operations/hosted-isolation.md)。

```sh
docker compose --project-directory /opt/vm2api-hosted \
  -f /opt/vm2api-hosted/compose.yml up -d
```

`VM2API_PANEL_COOKIE_NAME` 必须与镜像构建参数一致，防止同一 hostname 不同端口的面板会话互相覆盖。`VM2API_RELEASE_CHANNEL=hosted` 让版本页显示托管发布方式，并禁止调用上游安装脚本覆盖当前镜像；默认部署仍保留上游更新功能。

内置 Mihomo 与原生加密订阅 registry 管理线路，不需要第二个 sidecar 或另一份明文订阅。所有 listener、网络、容器、端口范围必须符合实例隔离配置。更新和回滚只更换新实例已验证的镜像引用，不回灌 OAuth、账号状态或出口锁。
