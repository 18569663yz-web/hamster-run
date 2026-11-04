#!/usr/bin/env bash
# Hamster Run — one-shot Cloudflare deploy.
#
# Order: check login → install deps → create D1 → apply migrations →
# set the signer secret (interactive, value never written to disk) →
# deploy the Worker → build + deploy the Pages frontend.
#
# Prerequisites: bun, and wrangler authenticated against YOUR
# Cloudflare account (`bun x wrangler login`, or CLOUDFLARE_API_TOKEN
# in the environment — see DEPLOY.md §1 for the exact token scopes).
# The script stops at the first step that needs something only the
# account owner can provide; each such stop says exactly what to do.
set -euo pipefail
cd "$(dirname "$0")"

PAGES_PROJECT="${PAGES_PROJECT:-hamster-run}"
DB_NAME="${DB_NAME:-hamster-run-db}"
API_BASE_MODE="${API_BASE_MODE:-same-origin}" # same-origin | workers-dev

step() { printf '\n== %s ==\n' "$1"; }

step "1/7 检查登录状态"
if ! bun x wrangler whoami >/dev/null 2>&1; then
  echo "还没有登录 Cloudflare。先运行:  bun x wrangler login"
  echo "（浏览器里用你自己的账号授权；或按 DEPLOY.md §1 建 API Token 后设置 CLOUDFLARE_API_TOKEN 环境变量。）"
  exit 1
fi
bun x wrangler whoami

step "2/7 安装依赖"
bun install

step "3/7 创建 D1 数据库（已存在则复用）"
if grep -q "REPLACE_WITH_YOUR_D1_DATABASE_ID" wrangler.toml; then
  OUT="$(bun x wrangler d1 create "$DB_NAME" 2>&1 || true)"
  echo "$OUT"
  DB_ID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
  if [ -z "${DB_ID}" ]; then
    echo "没能自动拿到 database_id（数据库可能已存在）。运行 bun x wrangler d1 list 找到 $DB_NAME 的 id，"
    echo "手动填进 wrangler.toml 的 REPLACE_WITH_YOUR_D1_DATABASE_ID 处，再重跑本脚本。"
    exit 1
  fi
  # portable in-place replace (GNU/BSD sed)
  sed -i.bak "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "database_id 已写入 wrangler.toml: $DB_ID"
else
  echo "wrangler.toml 已有 database_id，跳过创建。"
fi

step "4/7 应用 D1 迁移（远程）"
bun x wrangler d1 migrations apply "$DB_NAME" --remote

step "5/7 设置签名密钥（wrangler secret，值不会写进任何文件）"
if [ "${SKIP_SECRET:-0}" = "1" ]; then
  echo "SKIP_SECRET=1，跳过。注意：没设 MINT_SIGNER_PRIVATE_KEY 时，钱包玩家的链上 mint 授权会报「签名服务暂时不可用」（游戏其余功能不受影响）。"
else
  echo "接下来 wrangler 会提示你粘贴部署钱包的私钥（0x 开头 66 字符）。"
  echo "私钥只存进 Cloudflare 的加密 secret 存储，不进代码、不进本包、不回显。"
  echo "如果暂时不做链上 mint，直接 Ctrl+C 停在这里，之后单独运行:"
  echo "  bun x wrangler secret put MINT_SIGNER_PRIVATE_KEY"
  bun x wrangler secret put MINT_SIGNER_PRIVATE_KEY
fi

step "6/7 部署 Worker（API）"
bun x wrangler deploy
WORKER_URL="$(bun x wrangler whoami 2>/dev/null | grep -oE 'https://[^ ]*workers\.dev' | head -1 || true)"

step "7/7 构建并部署前端（Pages）"
# Build the shared client with the normal space build, then adapt its
# dist for Pages: inject the API base + cache headers.
( cd .. && bun ./client/build.mjs )
DIST="../client/dist"
if [ "$API_BASE_MODE" = "workers-dev" ]; then
  ACCOUNT_SUBDOMAIN="${CF_WORKERS_SUBDOMAIN:-}"
  if [ -z "$ACCOUNT_SUBDOMAIN" ]; then
    echo "API_BASE_MODE=workers-dev 需要 CF_WORKERS_SUBDOMAIN=<你的 workers.dev 子域名>（在 Cloudflare 控制台 Workers 页面右侧可以看到）。"
    exit 1
  fi
  API_BASE="https://hamster-run-api.${ACCOUNT_SUBDOMAIN}.workers.dev/api"
else
  API_BASE="/api"
fi
# inject window.__HAMSTER_API_BASE__ before the bundle module runs
python3 - "$DIST/index.html" "$API_BASE" <<'PY'
import pathlib, sys
path, api_base = sys.argv[1], sys.argv[2]
html = pathlib.Path(path).read_text()
inject = f'<script>window.__HAMSTER_API_BASE__={api_base!r};</script>'.replace("'", '"')
if "__HAMSTER_API_BASE__" not in html:
    html = html.replace("</title>", "</title>\n    " + inject, 1)
    pathlib.Path(path).write_text(html)
print("API base injected:", api_base)
PY
cp public/_headers "$DIST/_headers"
bun x wrangler pages deploy "$DIST" --project-name "$PAGES_PROJECT"

cat <<EOF

部署完成。接下来：
  - 前端网址： https://${PAGES_PROJECT}.pages.dev （每次部署也会给一个带哈希的预览网址，以 wrangler 输出为准）
  - API 健康检查： ${API_BASE}/health 应返回 {"ok":true,...}
  - 若用 same-origin 模式，还需在 Cloudflare 控制台给 Worker 加一条路由：
      Workers & Pages → hamster-run-api → Settings → Triggers → Routes
      添加 ${PAGES_PROJECT}.pages.dev/api/* 指向本 Worker（细节见 DEPLOY.md §3）。
  - 绑自己的域名：见 DEPLOY.md §4。
EOF
