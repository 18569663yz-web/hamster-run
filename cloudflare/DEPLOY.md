# 仓鼠快跑 · Cloudflare 部署手册（DEPLOY.md）

把游戏从 Muse 托管搬到你自己的 Cloudflare 账号：前端 **Pages**（静态托管）、后端 **Workers**（API）、数据库 **D1**（SQLite）。三者都有免费档，这个游戏的规模（约 100 人在线）远在免费额度内。

> 本包**不含任何密钥、私钥或账号信息**。部署需要你本人的 Cloudflare 登录授权，脚本会在需要你的地方停下来并说明。

---

## 0. 包里有什么

| 路径 | 内容 |
| --- | --- |
| `worker/src/index.ts` | Worker 入口：全部 18 个游戏动作（`getChallenge`、`verifySignature`、`startPreview`、`me`、`getMyHamsters`、`getProgression`、`requestMint`、`getMintAuthorization`、`confirmMint`、`getChainHamsters`、`getChampion`、`getDailyTrack`、`getRelay`、`getGhost`、`discoverImdpepe`、`startRun`、`submitRun`、`leaderboard`、`getWalletConnectConfig`），与 Muse 版同名同义 |
| `worker/src/sim.ts` | 计分模拟：与服务端现版**逐字节相同**的副本（`tests/sim-parity.ts` 自动核对） |
| `worker/src/evm.ts` / `schema.ts` | 钱包签名验签、数据库表定义，与现版同源 |
| `migrations/0001_init.sql` | D1 建表：`players`、`challenges`、`sessions`、`runs`、`hamster_levels`、`daily_tracks`、`relay_state`、`player_discoveries`、`mint_requests` |
| `wrangler.toml` | Worker 名称、D1 绑定（`DB`）、非敏感配置 |
| `public/_headers` | Pages 缓存头：带哈希的静态资源（含 GLB 模型）长缓存 1 年，`index.html` 每次校验 |
| `deploy.sh` | 一键脚本（建库 → 迁移 → 密钥 → Worker → Pages 的顺序已脚本化） |
| `tests/` | 两个自测：sim 一致性、D1 建表干净执行 |

客户端是**同一份源码**（仓库根目录 `client/`）：页面在加载时读 `window.__HAMSTER_API_BASE__` 决定后端地址；部署脚本会把它注入为 `/api`（同域优先）。CF 版客户端同时带两个健壮性修复（已同步进共享源码，Muse 线上版行为兼容）：`localStorage` 全部经 `client/src/storage.ts` 安全封装读写；`client/index.html` 内联预启动看门狗（资源加载失败自动绕缓存重载一次、15 秒未挂载显示带真实报错的兜底卡）。

---

## 1. 准备：登录授权（二选一）

### 方式 A：浏览器登录（最简单）
```bash
bun x wrangler login
```
浏览器打开 Cloudflare 授权页，用**你自己的账号**点 Allow。

### 方式 B：API Token（适合在服务器/终端里跑）
1. 打开 https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Create Custom Token**。
2. 权限逐项加这 4 条（一字不差地找同名项）：
   - **Account** · **Workers Scripts** · **Edit**
   - **Account** · **D1** · **Edit**
   - **Account** · **Cloudflare Pages** · **Edit**
   - **Account** · **Account Settings** · **Read**
3. Account Resources 选你的账号；创建后复制 token，在终端里：
```bash
export CLOUDFLARE_API_TOKEN=<粘贴你的 token>
export CLOUDFLARE_ACCOUNT_ID=<控制台首页右侧的 Account ID>
```
> token 只放环境变量，**不要**写进任何文件、不要提交进仓库。

---

## 2. 需要设置的 Secret（只有名字，没有值）

| Secret 名 | 必需性 | 说明 |
| --- | --- | --- |
| `MINT_SIGNER_PRIVATE_KEY` | 链上 mint 才需要 | 部署钱包（HamsterNFT v2 的 serverSigner，`0xD71b…6662`）的私钥，`0x` 开头 66 字符。只用于给 mint 授权签名。不设时游戏其余功能全部正常，只有钱包玩家的链上 mint 会提示「签名服务暂时不可用」。 |

设置方法（交互式粘贴，值不会写进任何文件、不会回显）：
```bash
bun x wrangler secret put MINT_SIGNER_PRIVATE_KEY
```
可选的非敏感变量（写在 `wrangler.toml` 的 `[vars]` 里，或控制台 Worker 设置里改）：`SEPOLIA_RPC_URL`（默认公共 RPC）、`WALLET_CONNECT_PROJECT_ID`（公开的客户端 ID，默认用包内已配置的项目 ID）。

---

## 3. 部署

```bash
cd cloudflare
bash deploy.sh
```
脚本顺序与预期输出：

1. **检查登录** — 没登录会停在这里，提示先 `wrangler login`。
2. **安装依赖** — `bun install` 完成。
3. **创建 D1** — 打印 `✅ Successfully created DB 'hamster-run-db'` 和 `database_id = "…"`，脚本自动把 id 写进 `wrangler.toml`。若库已存在，脚本会提示你用 `bun x wrangler d1 list` 查 id 手动填。
4. **应用迁移** — 打印 `🚣 Executed … queries` 类字样；9 张表建好。
5. **设置 Secret** — 提示粘贴私钥（见 §2；暂不做链上 mint 可 Ctrl+C 停在这里，其余步骤单独跑一遍时加 `SKIP_SECRET=1`）。
6. **部署 Worker** — 打印 `Published hamster-run-api` 和 workers.dev 地址。
7. **构建 + 部署前端** — 打印 `✨ Deployment complete!` 和本次部署的 pages.dev 预览地址。

### 让 /api 同域生效（same-origin 模式，推荐）
前端默认按同域 `/api` 调用后端，还需给 Worker 加一条路由（一次性）：
控制台 → **Workers & Pages** → **hamster-run-api** → **Settings（设置）** → **Triggers（触发器）** → **Routes（路由）** → Add route：
- Pattern：`hamster-run.pages.dev/api/*`（项目名不同就换成你的）
- Worker：`hamster-run-api`

> 备选（option B）：不想加路由时，用 `API_BASE_MODE=workers-dev CF_WORKERS_SUBDOMAIN=<你的子域名> bash deploy.sh` 重新部署前端，它会直连 `https://hamster-run-api.<子域名>.workers.dev/api`（Worker 已开 CORS）。

### 网址在哪看
- 固定网址：`https://hamster-run.pages.dev`（项目名 `hamster-run` 时）
- 每次部署的独立预览网址：`wrangler pages deploy` 输出里的 `https://<哈希>.hamster-run.pages.dev`
- 控制台 → Workers & Pages → hamster-run → Deployments 里也能看到全部地址。

### 验证部署成功
```bash
curl https://hamster-run.pages.dev/api/health     # 同域模式
# 或 curl https://hamster-run-api.<子域名>.workers.dev/api/health
```
应返回 `{"ok":true,"service":"hamster-run-api"}`。再打开 pages.dev 网址：大厅能打开、测试入口能进、能开一局并结算，即全链路通。

---

## 4. 绑自己的域名

1. 域名先转入/托管到 Cloudflare（控制台 → Websites → Add a site，按提示改 DNS 服务器；或直接在 Cloudflare 买）。
2. 控制台 → Workers & Pages → **hamster-run**（Pages 项目）→ **Custom domains** → Set up a domain → 输入如 `game.你的域名.com` → Continue → Cloudflare 自动加 DNS 记录并签证书（几分钟生效）。
3. 再给 Worker 加一条路由：pattern 换成 `game.你的域名.com/api/*`（同 §3 的位置）。
4. 打开 `https://game.你的域名.com` 验证；原 pages.dev 地址继续可用。

---

## 5. 回滚

- **前端**：控制台 → Workers & Pages → hamster-run → Deployments → 选上一个正常版本 → ⋯ → **Rollback to this deployment**。或本地切回旧代码重跑 `bash deploy.sh` 的第 7 步。
- **Worker**：控制台 → hamster-run-api → Deployments → 选旧版本 → Rollback。或 `bun x wrangler rollback`。
- **数据库**：D1 控制台 → hamster-run-db → **Time Travel** 可按时间点恢复（免费档保留 7 天）。迁移只加新表时一般不需要回滚数据库。
- **Muse 托管版不受影响**：搬家不改动 Muse 里的线上版，两边可以并存；确认 CF 版稳定后再决定是否停用旧入口。

---

## 6. 常见问题

- **打开 pages.dev 只剩渐变背景**：页面看门狗会在 15 秒内画出带真实报错的兜底卡；先强刷一次（或等它自动绕缓存重载）。仍不行，把兜底卡上的报错原样发给维护者定位。
- **开局报「Spaces bridge request failed」以外的 API 错误**：多半是 §3 的 Worker 路由没加，`/api` 被 Pages 当静态路径返回了 404。用上面的健康检查 curl 先确认。
- **钱包 mint 报「签名服务暂时不可用」**：`MINT_SIGNER_PRIVATE_KEY` 没设，或设的私钥对应的地址不是合约当前的 `serverSigner`。按 §2 重新设置。
- **本地先自测再部署**：
  ```bash
  cd cloudflare && bun install
  bun run test        # sim 一致性 + D1 建表
  bun run typecheck   # Worker 类型检查
  bun x wrangler dev  # 本地跑 Worker（需先 wrangler d1 migrations apply hamster-run-db --local）
  ```
