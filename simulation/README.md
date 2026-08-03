# Solar Cup 模擬 Runner

這是獨立的後端測試 runner。預設 `dry-run` 使用 mock adapter，沒有 Google API 寫入，也不讀取或保存任何 credential。

```bash
cd '/Users/dean/Desktop/solar cup賽務資訊網站/simulation'
npm test
npm run check
mkdir -p /private/tmp/solarcup-sim && touch /private/tmp/solarcup-sim/OBSERVER_READY
node runner.js dry-run --fast --state-dir /private/tmp/solarcup-sim --run-id demo
# 結果為 CANARY_WAITING_APPROVAL；確認本機結果後才放行：
touch /private/tmp/solarcup-sim/CANARY_APPROVED
node runner.js dry-run --fast --state-dir /private/tmp/solarcup-sim --run-id demo
```

模式：

- `dry-run`：唯一預設模式；mock 先跑 3 場 canary 並 exact restore，停在 `CANARY_WAITING_APPROVAL`。同一 `run_id` 只有在 `OBSERVER_READY` 與 `CANARY_APPROVED` 兩個檔案存在時才會進入主賽程。
- `run --armed`：預留給經審查的 Sheets REST adapter；必須有正確 `SOLAR_CUP_SPREADSHEET_ID`、`GOOGLE_ACCESS_TOKEN` 與 Spreadsheet allowlist。adapter 先讀取 metadata 解析 sheetId，且每筆寫入都有 read-before-write hash 比對與 readback。
- `restore-only --armed --run-id <id>`：只依既有 manifest 做三方比對復原；不建立新比分或 snapshot。

安全機制：

- `KILL_SWITCH`：在 state dir 建立同名檔案後，runner 於下一場開始前 P0 abort 並進入 restore。
- `--fast` 只可用於 dry-run；與 `--armed` 同時指定會 hard fail。armed mode 的 canary 使用正式 20–40 秒配對 jitter。
- `manifest.json`：保存 allowlist、exact pre-image、每筆 post-image、checkpoint 與 run state。
- `journal.jsonl`：append-only 的事件稽核軌跡。
- restore 使用 `current / post-image / pre-image` 三方比較，衝突時停止，不覆蓋協作者。
- 正式範圍涵蓋資格賽、淘汰賽與曜請賽三張表，共 310 場；比分只生成 `21 : 0–19`，無平手。
- **淘汰賽隊名（J/L）一併寫入**。`4_淘汰賽成績` 的隊名是賽務現場抽籤後手填的，系統裡沒有任何一段程式在推導晉級。若只寫 M/N 分數，編號反查（I/K）與勝方（O）公式會全部回傳空，`6_積分總表` 的止步一律「—」、名次分一律 0，球團總分只剩底分——整場演練會安靜地跑完卻一格積分鏈路都沒驗到。已於 2026-08-03 實測重現。

目前限制：Google Sheets REST API 的 `batchUpdate` 沒有 spreadsheet revision CAS。runner 以 `userEnteredValue` canonical hash read-before-write、寫後 readback evidence 與三方 restore comparison 降低風險，但不能取代真正的資料庫交易鎖。

armed gate 的 LIVE switch 固定讀取 `0_賽事設定!B12 = 0`；`B11` 是總場次，`B13` 是最後更新時間，兩者均不得作為 LIVE gate。

armed mode 必須明確提供 `SOLAR_CUP_SPREADSHEET_ID`、`GOOGLE_ACCESS_TOKEN`、`SOLAR_CUP_GCS_BUCKET` 與 `SOLAR_CUP_PROJECTION_BASELINES`。後者只能是固定範圍的 SHA-256 hash map，例如 `{"3":"<64 位 hex hash>","6":"<64 位 hex hash>","7":"<64 位 hex hash>","8":"<64 位 hex hash>"}`；範圍由程式鎖定為 `3:A1:Z109`、`6:A1:Z109`、`7:A1:Z11`、`8:A1:Z311`，環境變數無法覆寫。runner 以 GCS JSON API 的 object generation 作 fencing；少任一環境變數或 baseline 都 fail-closed。

## GitHub Actions 正式流程

Google Cloud 基礎設施已建立並完成設定驗證：

- GCS bucket：`solarcup-sim-state-944480593434`（`ASIA-EAST1`、PAP enforced、uniform bucket-level access、versioning、7 天 soft delete）。
- Workload Identity Federation：pool／provider `solarcup-gh-pool/solarcup-gh-provider`；provider 僅允許 repository ID `1288512590`、owner ID `254364847`、`refs/heads/main` 與 `workflow_dispatch`。
- service account 已完成 WIF 綁定，並具上述 bucket 的 `objectAdmin` 權限。

GitHub `production` Environment、repository variables／secret、目標 Google Sheet 分享權限，以及 workflow 的實際 production 執行仍待後續設定與驗證。

1. `dry-run.yml` 只跑 `ci-dry-run`，不要求 Google 環境變數、不建立 adapter、lease 或外部連線；它驗證完整的 310 場規劃。
2. `canary.yml` 在 `production` Environment 內 snapshot 全部 310 場，僅寫入前 3 場 canary，逐格 readback 後 exact restore，並把不可變 canary report 寫入 GCS。此時停在 `CANARY_WAITING_APPROVAL`。
3. 由 Browser 觀察試算表與 report 後，手動執行 `approve-canary.yml`。它只能依既有 report 建立一次 approval；相同 `run_id`／hash 的第二次建立會得到 GCS `412`，不會覆寫舊核准。
4. `simulate.yml` 使用同一 job 的 5 個累積 segment：`75 / 75 / 66 / 66 / 28`。每段開始前都以 SHA-pinned OIDC action 重取短效 access token（不建立 credentials file），並在 lease 前後重驗不可變 approval 的 `run_id` 與 manifest hash。segment 1 檢查完整 baseline；segment 2–5 只檢查 sheet、時區與 `B12 = 0`，讓已累積比分不會被舊 baseline 誤判。亂序、重跑錯段一律拒絕，且只有第 5 段才做 exact restore 與最終完整 baseline 檢查。
5. Actions production 流程唯一的放行依據是 GCS 中不可變的 canary report／approval。canary 或任一 simulate segment 失敗／取消時，recovery job 會以同一個完整權限的 production 環境執行 `restore-only`。`restore.yml` 也可在必要時獨立接管復原；遇到仍有效 lease 會在最多 90 秒內重試，403 或非 `LEASE_BUSY` 錯誤立即 fail-closed。

GCS durable state 固定在 `runs/<run_id>/`：`manifest`、`checkpoint`、`intent`、`restore`、`terminal`、append-only `journal/*` 與 `canary-report`／`approval`。每次 mutation 前都會驗證 generation fencing；復原採 `current / post-image / pre-image` 三方比較，衝突轉為 `MANUAL_HOLD`，不覆寫協作者資料。artifact 不含 token、Spreadsheet ID 或 snapshot。

必備 GitHub Environment / repository 設定：

- Environment：`production`（不要設定 required reviewer；以 `workflow_dispatch` 與不可變 canary approval 作為 gate，避免 recovery 被人工審核卡住。若未來需要 reviewer，另建僅供 `approve-canary` 使用的獨立審批 Environment）。
- Variables：`GCP_WIF_PROVIDER`、`GCP_WIF_SERVICE_ACCOUNT`、`SOLAR_CUP_SPREADSHEET_ID`、`SOLAR_CUP_GCS_BUCKET`。
- Secret：`SOLAR_CUP_PROJECTION_BASELINES`（僅固定 range 的 SHA-256 hash map）。
- Google WIF attribute condition：只允許 `DeanSolar999/solarcup-info` 的 `main` 分支與 `workflow_dispatch`；agent 分支只供 PR review，不應取得 production OIDC。

每個 production workflow 都會先檢查 `run_id` 格式，再取得 OIDC token；待 GitHub 與 Google Sheet 的後續設定完成後，才可實際啟動 production workflow。

## 淘汰賽晉級推導

`bracket.js` 解析 `bracket-tree.html` 的 `MNO` / `RR_PAIRS` / `TRI_PAIRS` 取得賽程拓撲——
哪一場屬於哪個五角形、哪三場是三角循環，這是賽程的既成事實，不另抄一份以免兩邊漂移；
解析失敗或場次數不符 132 一律 throw。

`knockout-resolver.js` 在每寫一場淘汰賽之前回頭讀雲端：

- 種子序來自 `3_資格賽積分榜` 的「自動晉級」與「組內排名」（後端算的，不是腳本算的）
- 晉級採 `4_淘汰賽成績` **O 欄勝方**（後端公式 `IF(M>N,I,K)` 的結果）往下推，
  不是拿腳本自己記的分數推——這才是在驗後端，否則只是自己跟自己對答案
- O 欄勝方與比分不符、或 O 欄為空時記為 finding 並繼續（演練期間只記不改）
- 上一輪未完賽時 throw `UNRESOLVED_MATCH`，不硬掰隊伍

模擬用的假設（不代表現場實際籤運，但不影響公式鏈驗證）：

- 初賽配對：同級別內第 1 名與第 2 名交錯後相鄰配對
- 休閒複賽：初賽勝方前 3 走三角循環，其餘 12 隊單淘汰

`dry-run` 背後是 mock，沒有公式引擎可讀 O 欄，因此用 `ScriptedResolver` 填佔位名——
它只證明「寫入四格＋snapshot＋restore 的機制正確」，**不宣稱證明晉級推導**。

## 離線全場驗證（不碰雲端）

```bash
node offline-sim.js /tmp/sim-310.json
python3 ~/Desktop/曜日盃賽務資料/後端資料庫_建置腳本/verify_offline.py /tmp/sim-310.json
```

`offline-sim.js` 產生 310 場的隊名＋比分與「這套分數應該算出什麼」的預期值；
`verify_offline.py` 灌進本機 xlsx、用 `formulas` 真的重算一次，再逐項比對
淘汰賽勝方 132 場、資格賽自動晉級 100 隊、積分總表 108 隊的止步／底分／名次分／隊伍總分、
球團積分 10 團，共 674 項。

2026-08-03 實測：674 項全過，名次分非 0 的隊伍 50 隊。
同一份分數若不寫 J/L 隊名，止步 108 隊全部變「—」、名次分 0 隊、球團總分只剩底分，
而且完全不報錯。
