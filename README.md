# Hamster Run（仓鼠快跑）

A 3D endless-runner game driven by real Squeekchain data: the daily track is generated from the latest settled block height, the ghost rival is paced by the real hamster SQUEEKTOSHI's historical wheel rounds, the SQUEEKTOSHI mileage relay unlocks new track themes for everyone, and each day's champion is automatically anchored on-chain. Characters are NFTs on Ethereum Sepolia (testnet assets with no real value), unlocked and leveled up by mileage, minted for 0.01 Sepolia ETH with server-side eligibility verification.

一款由 Squeekchain 真实数据驱动的 3D 跑酷游戏：每日赛道由最新已结算块高生成，影子对手来自真仓鼠 SQUEEKTOSHI 的历史轮次工作量，里程接力达标全服解锁新赛道主题，每日冠军自动写入 Sepolia 合约存证。角色 NFT 按里程解锁/升级、服务端核验资格后铸造（0.01 Sepolia ETH，测试网资产无真实价值）。

- Play: https://hamster-run.pages.dev
- Stack: React + Three.js client; TypeScript server actions (Muse artifact edition) and a Cloudflare Workers + D1 edition; Solidity contracts (HamsterNFT v2, ScoreLedger) on Sepolia.

Layout: `client/` game client, `server/` artifact-edition server, `cloudflare/` Workers/D1 edition (worker, migrations, deploy docs), `drizzle/` artifact-edition migrations, `contracts/` Solidity sources and deployment records.

Note: this snapshot contains source code only. Binary game assets (3D models, images, music), databases, build outputs and any secret files are intentionally excluded (see `.gitignore`).
