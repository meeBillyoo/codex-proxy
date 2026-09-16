# codex-proxy 服务器部署说明（8221）

## 部署信息

- 服务器：`34.28.243.240`
- SSH 用户：`collaborators`
- 工作目录：`/home/collaborators/services/codex-proxy`
- 源码目录：`/home/collaborators/services/codex-proxy/source`
- 监听地址：`0.0.0.0:8221`
- 运行方式：Node.js 24 + PM2
- PM2 任务名：`codex-proxy`

本方案不使用 Docker、Podman 或自定义 systemd 服务，应用进程统一由 PM2 管理。

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

部署前先检查 Node.js 主版本。本项目优先使用 Node.js 24；如果服务器当前不是
Node.js 24，则安装或加载 nvm，再安装并切换到 Node.js 24：

```bash
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"

if [ "$NODE_MAJOR" != "24" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi

  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24
  nvm alias default 24
fi

node --version
npm --version
```

`node --version` 必须输出 `v24.x.x` 后再继续安装部署。如果服务器已经是 Node.js
24，可直接复用当前 Node.js，无需强制改用 nvm。

使用将要运行 PM2 任务的同一个系统用户安装并登录 Codex CLI。服务只读取该用户的
`${CODEX_HOME:-$HOME/.codex}/auth.json`，不会在控制面板中发起 OAuth，也不会复制、
保存或刷新 token：

```bash
codex --version
codex login
test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"
```

然后执行：

```bash
cd /home/collaborators/services/codex-proxy/source

npm ci
cd web
npm ci
npm run build
cd ..
npx tsc
```

安装 PM2：

```bash
npm install --global pm2
pm2 --version
```

加载服务环境变量并创建 PM2 任务：

```bash
cd /home/collaborators/services/codex-proxy/source

set -a
. /home/collaborators/services/codex-proxy/.env
set +a

export NODE_ENV=production
export PORT=8221
export CODEX_PROXY_HOST=0.0.0.0

pm2 start dist/index.js \
  --name codex-proxy \
  --cwd /home/collaborators/services/codex-proxy/source \
  --interpreter "$(command -v node)" \
  --time

pm2 save
```

`pm2 save` 保存当前任务列表。本项目不创建 systemd 服务，也不执行 `pm2 startup`。
服务器重启后，由现有的 PM2 运维机制恢复任务；如果没有统一的开机调度，登录服务器后
手动执行 `pm2 resurrect`。

## 日常运维

查看状态：

```bash
pm2 status
pm2 describe codex-proxy
```

查看日志：

```bash
pm2 logs codex-proxy --lines 200 --nostream
```

实时日志：

```bash
pm2 logs codex-proxy
```

重启服务：

```bash
set -a
. /home/collaborators/services/codex-proxy/.env
set +a
pm2 restart codex-proxy --update-env
```

停止或重新启动任务：

```bash
pm2 stop codex-proxy
pm2 start codex-proxy
```

更新源码后重新部署：

```bash
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ "$NODE_MAJOR" != "24" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  . "$NVM_DIR/nvm.sh"
  nvm install 24
  nvm use 24
fi

node --version  # 必须为 v24.x.x
cd /home/collaborators/services/codex-proxy/source
npm ci
cd web && npm ci && npm run build && cd ..
npx tsc

set -a
. /home/collaborators/services/codex-proxy/.env
set +a
export NODE_ENV=production
export PORT=8221
export CODEX_PROXY_HOST=0.0.0.0

if pm2 describe codex-proxy >/dev/null 2>&1; then
  pm2 restart codex-proxy --update-env
else
  pm2 start dist/index.js \
    --name codex-proxy \
    --cwd /home/collaborators/services/codex-proxy/source \
    --interpreter "$(command -v node)" \
    --time
fi

pm2 save
```

## Codex CLI 账号

部署完成后打开：

```text
http://34.28.243.240:8221/
```

使用 `.env` 中的 `PROXY_API_KEY` 登录控制面板。页面显示的是 PM2 运行用户当前的
Codex CLI 账号；不能在页面中添加、删除或切换账号。

如果在服务启动后执行了 `codex login`、重新登录或切换认证文件，可重启任务：

```bash
pm2 restart codex-proxy --update-env
```

也可以在不重启进程的情况下重新加载：

```bash
curl -fsS -X POST http://127.0.0.1:8221/auth/reload \
  -H "Authorization: Bearer $API_KEY"
```

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

## 验收清单

- PM2 任务 `codex-proxy` 为 `online`。
- `0.0.0.0:8221` 监听成功。
- `/health` 返回 HTTP `200` 且 `authenticated=true`。
- `/v1/models` 不携带 Key 返回 HTTP `401`。
- `/v1/models` 携带正确 Key 返回 HTTP `200`。
- `/auth/account` 只返回当前 CLI 账号信息，不包含任何 token。
- `gpt-5.6-sol` 实际调用成功。
