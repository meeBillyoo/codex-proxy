# codex-proxy 服务器标准部署说明（8221）

本文档是所有 codex-proxy 服务器的统一部署合同。新增服务器、日常更新、故障修复和
回滚都必须遵循同一套 release 流程；服务器之间只允许连接信息、系统用户和应用根目录
不同，不应各自维护另一套部署命令。

本方案不使用 Docker、Podman 或项目自建 systemd 服务。应用统一使用 Node.js 24、
PM2、不可变 release 目录、`current` 软链接以及共享运行数据目录。

## 服务器登记表

| 名称 | SSH | 应用根目录 | 状态 |
| --- | --- | --- | --- |
| `GCUbuntuDemo` | `ssh clawbot@35.201.250.172 -i /Users/token/Work/sshfile/id_rsa_omnisciate` | `/home/clawbot/apps/codex-proxy` | 已按本标准部署 |
| 原 `34.28.243.240` 环境 | `ssh collaborators@34.28.243.240` | `/home/collaborators/services/codex-proxy` | 历史固定目录部署，更新前应迁移到本标准 |

新增服务器时先在本表登记名称、SSH 连接方式和应用根目录。不要在文档中记录私钥内容、
`PROXY_API_KEY`、Codex 登录 token 或其他凭据。

## 统一参数

登录目标服务器后先设置该服务器的参数。除 `APP_ROOT` 外，所有服务器原则上使用相同
值：

```bash
APP_ROOT="$HOME/apps/codex-proxy"
REPO_URL=https://github.com/meeBillyoo/codex-proxy.git
DEPLOY_BRANCH=dev
PORT=8221
PM2_APP_NAME=codex-proxy
```

标准目录结构如下：

```text
<APP_ROOT>/
├── current -> releases/<release-id>
├── releases/
│   ├── <previous-release-id>/
│   └── <release-id>/
└── shared/
    ├── codex-proxy.env
    └── data/
```

约束：

- `releases/<release-id>` 是可回滚的完整源码和构建产物。
- `current` 只指向通过切换前检查的 release。
- 每个 release 的 `data` 必须链接到 `shared/data`。
- `shared/codex-proxy.env` 必须保持 `600` 权限。
- 切换和回滚不得覆盖或删除 `shared`。
- 不在 release 中直接开发或手工修改源码；修复应提交到仓库，再部署新 release。

## 运行时准备

### Node.js、npm、PM2 和 Rust

项目要求 Node.js 24。Linux 原生 TLS transport 需要 Rust/N-API 构建工具链：

```bash
export NVM_DIR="$HOME/.nvm"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

. "$NVM_DIR/nvm.sh"
nvm install 24
nvm use 24
nvm alias default 24

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  . "$HOME/.cargo/env"
fi

npm install --global npm@11.9.0 pm2

node --version
npm --version
pm2 --version
cargo --version
```

`node --version` 必须为 `v24.x.x`。非交互 SSH 不一定加载 nvm；自动化脚本和运维命令
必须显式加载 `$HOME/.nvm/nvm.sh`，不能假定 `npm` 和 `pm2` 已经位于 `PATH`。

### Codex CLI 账号

使用运行 PM2 的同一个系统用户安装并登录 Codex CLI：

```bash
codex --version
codex login
test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"
```

服务读取该用户的 `${CODEX_HOME:-$HOME/.codex}/auth.json`。不得把 auth 文件复制进
release，也不得在部署日志中打印其中的 token。

### 共享配置

创建标准目录并写入服务器自己的环境文件：

```bash
mkdir -p "$APP_ROOT/releases" "$APP_ROOT/shared/data"
touch "$APP_ROOT/shared/codex-proxy.env"
chmod 600 "$APP_ROOT/shared/codex-proxy.env"
```

环境文件至少提供：

```dotenv
PROXY_API_KEY=<server-specific-secret>
```

各服务器应使用独立、高熵的 Key。不要在命令行参数、Git、聊天记录或部署文档中保存
真实 Key。

## 标准发布流程

### 1. 登录并设置参数

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 24
export PATH="$HOME/.cargo/bin:$PATH"

APP_ROOT="$HOME/apps/codex-proxy"
REPO_URL=https://github.com/meeBillyoo/codex-proxy.git
DEPLOY_BRANCH=dev
PORT=8221
PM2_APP_NAME=codex-proxy
```

### 2. 创建 release

每次发布创建新目录，不在 `current` 指向的运行版本中执行 `git pull`：

```bash
set -e

RELEASE_ID="$(date -u +%Y%m%d-%H%M%S)"
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"

mkdir -p "$APP_ROOT/releases" "$APP_ROOT/shared/data"

git clone --depth 1 --branch "$DEPLOY_BRANCH" \
  "$REPO_URL" \
  "$RELEASE_DIR"

ln -s ../../shared/data "$RELEASE_DIR/data"
```

记录部署提交，后续验收必须确认 `HEAD` 与远端分支一致：

```bash
git -C "$RELEASE_DIR" fetch --prune origin
git -C "$RELEASE_DIR" rev-parse HEAD
git -C "$RELEASE_DIR" rev-parse "origin/$DEPLOY_BRANCH"
```

### 3. 安装依赖和构建

根项目、原生模块和 Web 项目有各自的依赖安装步骤，三者都不能省略：

```bash
cd "$RELEASE_DIR"
npm ci

cd "$RELEASE_DIR/native"
npm ci
npm run build
test -s codex-tls.linux-x64-gnu.node

cd "$RELEASE_DIR/web"
npm ci

cd "$RELEASE_DIR"
npm run build
test -s dist/index.js
test -s public/index.html
```

根目录的 `npm run build` 只构建 Web 和 TypeScript，不会生成 Linux 原生 TLS 模块。
必须单独执行 `native/npm run build`。

2026-09-18 曾发生 release 漏掉 `native/codex-tls.linux-x64-gnu.node` 的事故，PM2
连续重启后进入 `errored`，日志为：

```text
Cannot find module 'codex-tls-linux-x64-gnu'
```

### 4. 切换前检查

验证原生模块导出：

```bash
cd "$RELEASE_DIR"
node - <<'NODE'
const bindings = require("./native/index.js");
for (const name of ["httpGet", "httpPost", "httpPostStream"]) {
  if (typeof bindings[name] !== "function") {
    throw new Error(`native export missing: ${name}`);
  }
}
console.log("native addon OK");
NODE
```

确认 release 没有意外源码改动；允许的未跟踪项只有标准 `data` 软链接和构建产物：

```bash
git -C "$RELEASE_DIR" status --short --branch
readlink "$RELEASE_DIR/data"
```

### 5. 原子切换 current

先记录旧 release，再替换 `current`：

```bash
OLD_RELEASE="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
echo "Previous release: $OLD_RELEASE"

ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
```

`OLD_RELEASE` 是本次发布的直接回滚目标。在新版本验收完成前不得删除它。

### 6. 创建或重启 PM2 任务

已有任务时，保留 PM2 中的现有运行环境并重启：

```bash
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME"
else
  set -a
  . "$APP_ROOT/shared/codex-proxy.env"
  set +a

  export NODE_ENV=production
  export PORT
  export CODEX_PROXY_HOST=0.0.0.0

  pm2 start "$(command -v npm)" \
    --name "$PM2_APP_NAME" \
    --cwd "$APP_ROOT/current" \
    --interpreter "$(command -v node)" \
    --time \
    -- start
fi
```

如果本次发布同时修改了 `shared/codex-proxy.env`，必须先加载新值，并使用
`--update-env` 重启：

```bash
set -a
. "$APP_ROOT/shared/codex-proxy.env"
set +a
export NODE_ENV=production
export PORT
export CODEX_PROXY_HOST=0.0.0.0
pm2 restart "$PM2_APP_NAME" --update-env
```

默认不要设置 `CODEX_PROXY_DISABLE_WS`：服务优先使用上游 Responses WebSocket，
无状态请求遇到握手/传输故障会自动回退到 HTTP SSE。只有目标网络完全无法访问上游
WebSocket 时，才在 `shared/codex-proxy.env` 中设置
`CODEX_PROXY_DISABLE_WS=1` 并用 `--update-env` 重启。

不要在切换前执行 `pm2 save`。只有新 release 通过全部验收后才保存任务列表。

## 验收

### 进程和启动日志

```bash
pm2 status "$PM2_APP_NAME"
pm2 describe "$PM2_APP_NAME"
pm2 logs "$PM2_APP_NAME" --lines 120 --nostream
ss -lntp | grep ":$PORT "
```

PM2 必须为 `online`，观察期间 restart 计数不能继续增长。启动日志必须包含：

```text
[TLS] Using native (rustls) transport
Status: Authenticated
```

### 健康和鉴权

```bash
BASE_URL="http://127.0.0.1:$PORT"

curl -fsS "$BASE_URL/health"

set -a
. "$APP_ROOT/shared/codex-proxy.env"
set +a

# 不带 Key 必须返回 401。
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$BASE_URL/v1/models"

# 带 Key 必须返回 200。
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$BASE_URL/v1/models" \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

`/health` 必须返回 HTTP `200`，并包含 `"status":"ok"`、
`"authenticated":true` 和 active 账号状态。

### 外部验证

从另一台机器验证该服务器的公网地址：

```bash
curl -fsS "http://<server-public-ip>:$PORT/health"
```

如果服务器本机正常但公网超时，检查云防火墙是否允许 TCP `8221`。生产环境应限制
可信来源 IP，或者在公网入口前配置 HTTPS 反向代理。

### 最终验收清单

- `HEAD` 与 `origin/$DEPLOY_BRANCH` 一致。
- 原生 TLS 模块存在并能加载三个预期导出。
- 根项目、Web 和 TypeScript 生产构建成功。
- `current` 指向本次 release，`data` 指向 `shared/data`。
- PM2 任务为 `online`，restart 计数稳定。
- `0.0.0.0:8221` 正常监听。
- `/health` 返回 HTTP `200` 且认证账号 active。
- `/v1/models` 无 Key 返回 `401`，正确 Key 返回 `200`。
- 模型同步日志正常，没有新的启动错误。
- 公网健康检查成功。

验收全部通过后执行：

```bash
pm2 save
```

## 回滚

任何关键验收失败都应立即回滚，不在故障 release 上临时堆叠修改：

```bash
ROLLBACK_RELEASE="$APP_ROOT/releases/REPLACE_WITH_PREVIOUS_RELEASE_ID"

test -d "$ROLLBACK_RELEASE"
ln -sfn "$ROLLBACK_RELEASE" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
pm2 restart "$PM2_APP_NAME"
curl -fsS "http://127.0.0.1:$PORT/health"
pm2 save
```

回滚只切换代码和构建产物。不得删除或回滚 `shared/data`，不得覆盖
`shared/codex-proxy.env`。

## 日常运维

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 24

pm2 status codex-proxy
pm2 describe codex-proxy
pm2 logs codex-proxy --lines 200 --nostream
```

服务启动后如果重新执行了 `codex login` 或替换认证文件，可重启或热加载账号：

```bash
pm2 restart codex-proxy

set -a
. "$APP_ROOT/shared/codex-proxy.env"
set +a
curl -fsS -X POST "http://127.0.0.1:$PORT/auth/reload" \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

## 常见故障

### 非交互 SSH 找不到 npm 或 PM2

原因通常是未加载 nvm：

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 24
```

### PM2 为 errored

```bash
pm2 describe codex-proxy
pm2 logs codex-proxy --lines 200 --nostream
```

如果出现 `Cannot find module 'codex-tls-linux-x64-gnu'`，说明 release 不完整。标准处理
是构建一个包含 Linux 原生模块的新 release；紧急恢复时可以先回滚到上一个完整 release。

### 客户端仍请求 api.openai.com

如果错误 URL 是 `https://api.openai.com/v1/responses`，请求没有进入本代理。检查 Codex
App 的 `model_provider`、`base_url` 和 Bearer Token，完全退出并重新打开 App，然后
新建会话。旧会话可能继续使用创建时保存的 provider。

客户端基础地址应为：

```text
http://<server-public-ip>:8221/v1
```

### PM2 开机恢复

所有服务器统一由既有 PM2 运维机制恢复进程。本项目不自行创建 systemd 服务，也不在
日常发布中重复执行 `pm2 startup`。如果服务器重启后任务没有自动恢复，登录相同系统
用户执行：

```bash
pm2 resurrect
```

随后重新执行完整验收。
