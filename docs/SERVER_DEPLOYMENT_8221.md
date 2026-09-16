# codex-proxy 服务器部署说明（8221）

## 部署信息

- 服务器：`34.28.243.240`
- SSH 用户：`collaborators`
- 工作目录：`/home/collaborators/services/codex-proxy`
- 源码目录：`/home/collaborators/services/codex-proxy/source`
- 监听地址：`0.0.0.0:8221`
- 运行方式：Node.js 24 + systemd user service
- systemd 服务名：`codex-proxy.service`

本方案不使用 Docker 或 Podman。

## Key 配置

Key 保存在服务器文件：

```text
/home/collaborators/services/codex-proxy/.env
```

文件权限必须保持为 `600`。查看完整配置：

```bash
cat /home/collaborators/services/codex-proxy/.env
```

只显示 Key 值：

```bash
sed -n 's/^PROXY_API_KEY=//p' /home/collaborators/services/codex-proxy/.env
```

客户端按照 OpenAI API 格式携带：

```http
Authorization: Bearer <PROXY_API_KEY>
```

## 首次部署

服务器使用以下 Node.js：

```text
/home/collaborators/.nvm/versions/node/v24.19.0/bin/node
```

在服务器执行：

```bash
export PATH=/home/collaborators/.nvm/versions/node/v24.19.0/bin:$PATH
cd /home/collaborators/services/codex-proxy/source

npm ci
cd web
npm ci
npm run build
cd ..
npx tsc

mkdir -p ~/.config/systemd/user
```

启动前创建 `~/.config/systemd/user/codex-proxy.service`：

```ini
[Unit]
Description=Codex Proxy API on port 8221
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/collaborators/services/codex-proxy/source
EnvironmentFile=/home/collaborators/services/codex-proxy/.env
Environment=NODE_ENV=production
Environment=PORT=8221
Environment=CODEX_PROXY_HOST=0.0.0.0
Environment=PATH=/home/collaborators/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/collaborators/.nvm/versions/node/v24.19.0/bin/node dist/index.js
Restart=always
RestartSec=3
TimeoutStopSec=30
StandardOutput=append:/home/collaborators/services/codex-proxy/service.log
StandardError=append:/home/collaborators/services/codex-proxy/service.log

[Install]
WantedBy=default.target
```

保存服务文件后执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-proxy.service
```

管理员需要为 `collaborators` 开启 linger，确保退出 SSH 和服务器重启后服务仍能启动：

```bash
sudo loginctl enable-linger collaborators
```

## 日常运维

查看状态：

```bash
systemctl --user status codex-proxy.service --no-pager
```

查看日志：

```bash
tail -n 200 /home/collaborators/services/codex-proxy/service.log
```

实时日志：

```bash
tail -f /home/collaborators/services/codex-proxy/service.log
```

重启服务：

```bash
systemctl --user restart codex-proxy.service
```

更新源码后重新部署：

```bash
export PATH=/home/collaborators/.nvm/versions/node/v24.19.0/bin:$PATH
cd /home/collaborators/services/codex-proxy/source
npm ci
cd web && npm ci && npm run build && cd ..
npx tsc
systemctl --user restart codex-proxy.service
```

## 首次登录上游账号

部署完成后打开：

```text
http://34.28.243.240:8221/
```

先使用 `.env` 中的 `PROXY_API_KEY` 登录控制面板，然后完成 OpenAI/ChatGPT OAuth 登录。只有账号池中至少存在一个有效账号后，服务才能刷新完整模型列表并真正调用 `gpt-5.6-sol`。

## 验证

在服务器读取 Key，避免把密钥写入 Shell 历史：

```bash
API_KEY="$(sed -n 's/^PROXY_API_KEY=//p' /home/collaborators/services/codex-proxy/.env)"
BASE_URL=http://127.0.0.1:8221
```

健康检查：

```bash
curl -fsS "$BASE_URL/health"
```

未携带 Key 应返回 `401`：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE_URL/v1/models"
```

查询大模型列表：

```bash
curl -fsS "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

调用 `gpt-5.6-sol`：

```bash
curl -fsS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "messages": [{"role": "user", "content": "只回复：codex-proxy-8221-ok"}],
    "stream": false
  }'
```

外部访问地址：

```text
http://34.28.243.240:8221/v1
```

如果服务器本机验证成功但外部连接超时，需要在云平台防火墙中放行 TCP `8221`。生产环境建议仅允许可信来源 IP，并在公网入口前增加 HTTPS 反向代理。

## 2026-09-16 部署验收记录

- `codex-proxy.service`：运行中
- `0.0.0.0:8221`：监听成功
- 外部地址 `http://34.28.243.240:8221/health`：HTTP `200`
- `/v1/models` 不携带 Key：HTTP `401`
- `/v1/models` 携带正确 Key：HTTP `200`
- 当前账号池：`0` 个账号，`authenticated=false`
- 当前静态模型列表不包含 `gpt-5.6-sol`
- `gpt-5.6-sol` 调用：HTTP `401`，原因是尚未登录上游账号；完成控制面板 OAuth 后需要重新执行验证命令
