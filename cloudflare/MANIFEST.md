# 迁移包清单与验证记录（MANIFEST）

生成于 2026-11-02 构建时。本包位于 Muse 托管版仓库的 `cloudflare/` 目录，与线上版共用同一份客户端源码；**实际部署未执行**（需要账号主人的 Cloudflare 授权，步骤见 `DEPLOY.md`，一键脚本 `deploy.sh` 会在需要授权处停下）。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `DEPLOY.md` | 账号主人部署手册（Token 权限清单、命令、预期输出、网址位置、绑域名、回滚） |
| `deploy.sh` | 一键部署脚本：查登录 → 装依赖 → 建 D1 → 跑迁移 → 设 secret → 部署 Worker → 构建并部署 Pages |
| `wrangler.toml` | Worker `hamster-run-api` + D1 绑定 `DB`（database_id 为占位符，脚本自动回填） |
| `package.json` | 包脚本：`typecheck` / `build:worker` / `test`（sim + d1） |
| `migrations/0001_init.sql` | D1 建表：players、challenges、sessions、runs、hamster_levels、daily_tracks、relay_state、player_discoveries、mint_requests + 索引（与现版 schema 字段语义一致） |
| `public/_headers` | Pages 缓存头：`/assets/*` 与 GLB 长缓存 1 年 immutable；`index.html` must-revalidate |
| `worker/src/index.ts` | Worker 入口（1202 行）：18 个动作与现版同名同义同规则；HTTP 形态 `POST /api/<动作名>`（另兼容 `POST /api {action,args}` 与 `GET /api/health`） |
| `worker/src/sim.ts` | 计分模拟，与现版逐字节相同（md5 `608944d4c50347f44d44be6930a850e6`，与 `server/src/sim.ts`、`client/src/sim.ts` 三方一致） |
| `worker/src/evm.ts` | 验签/签名，与现版逐字节相同（md5 `34f1e4837baf53976d5534d1ba7fdb21`） |
| `worker/src/schema.ts` | 表定义，与现版逐字节相同（md5 `0916b3c7a13a65c8ec2278aef3643b21`） |
| `worker/src/wallet-connect-config.ts` | WalletConnect 公开配置（项目 ID 为公开客户端标识，非密钥） |
| `worker/tsconfig.json` | Worker 类型检查配置 |
| `tests/sim-parity.ts` | sim 一致性自测（9 组种子/角色/等级/输入对照） |
| `tests/d1-schema.ts` | D1 迁移在本地 SQLite 干净执行 + 核心读写冒烟 |

密钥规则：部署钱包私钥只走 `wrangler secret put MINT_SIGNER_PRIVATE_KEY`，包内任何文件不含密钥值（`wrangler.toml`、源码、文档均只有名字）。

## 共享客户端的两处健壮性修复（同时进 CF 包与 Muse 线上版）

- `client/src/storage.ts`：localStorage 安全封装；`App.tsx` / `i18n.tsx` / `music.ts` 全部改走封装，全仓裸 `localStorage` 只剩封装内部。
- `client/index.html`：内联预启动看门狗（资源失败自动绕缓存重载一次、15 秒未挂载画带真实报错的兜底卡、挂载后自动解除）。
- `client/src/api.ts`：后端地址可配置——页面设 `window.__HAMSTER_API_BASE__` 时走 HTTP `/api` 通道，未设时仍走 Muse SDK 通道，线上行为不变。

## 验证记录（构建时实跑）

1. **类型检查 + 打包**：`bun run typecheck`（worker）通过；`bun build` 打出 worker.js 194 KB；仓库根 `bun run typecheck`（client+server）通过。
2. **sim 一致性**（`bun run test:sim`，9/9 一致）摘录：
   - seed=20261102 lizi Lv1 无输入 → 现版 2973 分 / CF 2973 分（dist 336、seeds 108、ticks 1549）
   - seed=5973 lizi Lv3 40 输入 → 528 分，双方一致
   - seed=31337 imdpepe Lv1 50 输入 → 480 分，双方一致
   - 非法输入（间隔 <4 tick）→ 双方同样判 invalid
3. **Worker 本地端到端**（`wrangler dev --local` + 本地 D1 跑迁移 17 条命令成功）：
   - `POST /api/startPreview` → 建号成功（player id 1）
   - `POST /api/startRun` → seed=930596799（本地沙箱无外网，走了与现版相同的 fallback-dayhash 语义）
   - `POST /api/submitRun`（空输入）→ accepted，**score=1140 / distance=141 / seeds=6**
   - 同种子用现版 `server/src/sim.ts` 独立重算 → **score=1140 / distance=141 / seeds=6 / ticks=800，逐项一致**
   - `getProgression` totalM=141、stats.runs=1 写回正确；`leaderboard` 正确排除测试号（空榜）
4. **D1 迁移**（`bun run test:d1`）：在内存 SQLite 干净执行，9 张表齐全，player→session→run→board 冒烟通过；`wrangler d1 migrations apply --local` 同样成功。

## 实际部署记录（2026-11-03，账号主人授权其 API Token 仅本次使用，部署后即弃）

部署方式说明：本机代理环境下 wrangler 的 undici 连接复用屡次 `UND_ERR_SOCKET`（whoami 的第二个请求即断），故改走与 wrangler 相同的 Cloudflare REST API 逐项执行（curl 每请求新连接，全程稳定）；执行顺序、资源命名、绑定关系与 `deploy.sh` 完全一致，跳过 secret 步骤（SKIP_SECRET 等价）。

| 步骤 | 结果 |
| --- | --- |
| Token 验证 | `GET /user/tokens/verify` → active；账号下 1 个 account |
| D1 创建 | `hamster-run-db`，database_id `afb8d4c4-d7d8-43f4-9f3e-2524fa27ad6f`（已回填 `wrangler.toml`） |
| D1 迁移 | `migrations/0001_init.sql` 16 条语句逐条执行，全部成功（9 表 + 索引） |
| Worker 部署 | `bun run build:worker`（194 KB）→ API 上传 `hamster-run-api`，D1 绑定 `DB`，compatibility_date 2025-09-01 + nodejs_compat；workers.dev 已启用，账号子域名 `18569663yz` |
| Pages 项目 | `hamster-run`（production_branch=main），子域名 `hamster-run.pages.dev` |
| Pages 文件 | 与当前 Muse 版同一份 `client/dist`（21 文件 / 22.9 MB），注入 `window.__HAMSTER_API_BASE__ = "https://hamster-run-api.18569663yz.workers.dev/api"`（workers-dev 直连模式，Worker 已开 CORS `*`），附 `public/_headers`；21/21 按 Pages 直传协议（blake3 哈希 + check-missing + upload + upsert-hashes）上传成功 |
| Pages 部署 | deployment `e22fcaf3-41ac-4507-8672-edbf7134a0b6`，latest_stage = deploy success，环境 production |

### 公开网址
- **游戏（正式）：https://hamster-run.pages.dev**
- 本次部署预览：https://e22fcaf3.hamster-run.pages.dev（部署 API 已签发；本沙箱代理无法解析该哈希子域名，未能从本机复核，以正式域名为准）
- API：https://hamster-run-api.18569663yz.workers.dev/api/health → `{"ok":true,"service":"hamster-run-api"}`

### 部署后实测（真 Worker + 真 D1，非本地）
- `startPreview` → 建号成功；`startRun`（lizi）→ seed 619373324、squeekBlock 6808（实时 Squeekchain）、trackSource squeekchain
- `submitRun`（空输入）→ accepted，服务端重算 score 1971 / distance 240 / seeds 25，squeekBlock 6808
- `getProgression` → totalM 240、stats.runs 1 写回正确；`leaderboard` 正确排除测试号（空榜）
- `getDailyTrack` → dayId 2026-11-02、blockHeight 6808；`getGhost` → round 1022、work 672、factor 1.28（实时）；`getRelay` → available，currentKm 66.73（新库首读即基线，gainedKm 0、unlockedThemes 1——与现版「首读基线」语义一致）；`getWalletConnectConfig` → configured true
- Pages：`/` 200 且注入正确；JS bundle 与 GLB 模型均 200 全量下载；带 Origin 的跨域 POST 返回 CORS 头且数据正常

### 待补项
1. **MINT_SIGNER_PRIVATE_KEY 未设置**（部署钱包私钥未授权放入 Cloudflare）：钱包玩家调用 `getMintAuthorization` 会得到「签名服务暂时不可用」；游戏其余功能不受影响。补法：账号主人执行 `bun x wrangler secret put MINT_SIGNER_PRIVATE_KEY`（在 cloudflare/ 目录，需 wrangler 登录态）。
2. **same-origin /api 未启用**：当前前端直连 workers.dev（CORS 已开、全功能可用）。若日后绑自定义域名，按 DEPLOY.md §3/§4 给 Worker 加 `hamster-run.pages.dev/api/*` 或自有域名 `/api/*` 路由后，可改回同域模式重部署前端。
3. 部署用的 API Token 已按约定弃用，建议账号主人在令牌页将其删除（它曾在聊天中出现）。
