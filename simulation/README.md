# Solar Cup 模擬 Runner

這是獨立的後端測試 runner。預設 `dry-run` 使用 mock adapter，沒有 Google API 寫入，也不讀取或保存任何 credential。

## ⚠️ 入座事實來源：site-engine.js（2026-08-12 轉正）

**淘汰賽入座推導一律走 `site-engine.js`**——它在 vm 隔離執行環境
（`vm.runInNewContext`，timeout 5s，context 內 process／require／fetch／fs
不可達，避免網站原始碼意外觸及本機資源）直跑 `bracket-tree.html` 摘取的
原始邏輯段，摘取採兩層存在性驗證（regex 錨點＋執行後 shape 驗證：
MNO 132 場唯一、RR/TRI 完整循環、SEATS 10 席），網站改版時自動跟進或
fail-closed 於 `SITE_EXTRACT_*`。

> ⚠️ **`node:vm` 不是安全邊界。** 官方定位就不是 security boundary：
> `this.constructor.constructor('return process.pid')()` 這類逃逸在本環境
> 實測可行，能取回真正的 host process。上面的隔離只擋「意外」（誤觸本機
> 資源、無窮迴圈），擋不住惡意程式。
> 本引擎**僅**用於執行本專案自有的 `bracket-tree.html`，**嚴禁餵入不可信
> 來源的程式碼**（外部 HTML、使用者輸入、第三方片段）。若日後真有跑不可信
> 輸入的需求，必須改用獨立進程 ＋ OS 級權限限制／容器，不得沿用本檔。
> `sandboxIsolationProbe()` 回傳的 `isolated: true` 只代表「沒有意外洩漏的
> 全域」，不是安全保證；回歸測試 `site-engine.test.js` 已把這個界線釘住。

**脫節史（為什麼轉正）**：finalrun-20260811 三輪對帳發現本目錄
`bracket.js seedsFor()` 的「假抽籤」（名次分層＋名冊編號交錯配對）與
網站實際入座（`poolFromTD`：各組第 1、2 名依組序、初賽＝同組冠亞重賽；
黃金/青銅＝各組第 3、4 名）不一致——複賽以下結構相同，但初賽池建構
的差異讓 132 場入座全部錯位，且 8/3 演練後網站又改了多輪，解析器
複製品必然漂移。`seedsFor` 已標 deprecated，僅為既有測試保留。

**初賽配對規則＝現場抽籤（2026-08-12 團長定案）**：正式賽日初賽對戰
由現場抽籤後手填雲端。任何工具不得假設可預測配對；site-engine 的
結構推演只是演練佔位。

**銜接狀態：已校準（2026-08-13）**。bracket-tree 雲端化改版
（playM 只讀雲端、隊名空＝「待定（抽籤後公布）」、rrMembers＝雲端
聯集、季殿＝雲端 #third 列）落地後，site-engine 已完成錨點重校準
（RR_PAIRS 等結構鏈錨點移除，新增 teamFromCloud／TBD_DRAW／
rrMembers／rrAmbiguity）並收斂為兩個角色：
`loadTopology()`（拓撲常數解析：MNO 132 場 shape 斷言）＋
`replayVerify(liveMatches)`（雲端結果重放：灌快照進網站原始
buildTier，取回站方名次榜／並列旗標／placePts／冠亞季殿＋一致性
findings）。結構推演 `deriveSeating` 已移除（呼叫即 throw 指路），
歷史正本封存於 `推演executor備份_20260811/site-engine-v1-structural.js`
（finalrun write-plan f2bd687c 建置時代）。`knockout-resolver.js`
禁令解除，角色收斂為純驗證（O 欄 vs 比分、雲端隊名合法性）。

**回歸測試：`site-engine.test.js`（2026-08-13 新增）**。原本的重放自測
「executor selftest ⑦」只活在 finalrun 的一次性產物裡，程式庫 grep 不到，
等於「宣稱驗過但沒人能重跑」的證據鏈斷點；現已落地成常駐測試，`npm test`
自動納入，全程離線（不碰雲端、不發網路請求），涵蓋：`loadTopology()` 對
現行 HTML 通過（132 場唯一、逐輪數量）、合成全 132 場完賽快照重放
（doneCount 132、findings 0、四級冠亞季殿與名次分）、四種毒快照各驗一種
finding（`ILLEGAL_SCORE` × 2、`NAME_NOT_ROSTER`、`SELF_MATCH`）、
`deriveSeating` 墓碑、`bracket.js` 官方配對常數形狀，以及上述 vm 界線釘樁。

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

正式全日推演入口為 `autonomous-simulate.yml`；`workflow_dispatch` 的 `preflight_only=true` 只驗 WIF、GCS lease、備份、projection、LIVE switch 與 1–310 mapping，不建立 run state，也不啟動 simulate／recovery。確認成功後，改用新的唯一 `run_id` 並維持預設 `false`，才會自動完成 canary、清空輸入、5 段推演、前端觀測、exact restore 與最終報告。

1. `dry-run.yml` 只跑 `ci-dry-run`，不要求 Google 環境變數、不建立 adapter、lease 或外部連線；它驗證完整的 310 場規劃。
2. `autonomous-simulate.yml` 先 snapshot 全部 310 場，再對資格賽、淘汰賽、曜請賽三張輸入表各寫一格 sentinel。readback 正確、對外網站全部可 render，且三格 exact restore 後，才進入 clear barrier 與正式推演。
3. 5 個累積 segment 為 `75 / 40 / 75 / 75 / 45`（index 邊界 `0–75 / 75–115 / 115–190 / 190–265 / 265–310`）。預估時間依序為 `38 分 05 秒 / 45 分 / 37.5 分 / 37.5 分 / 22.5 分`；第 1 段含 35 秒延遲情境，第 2 段含 25 分鐘開幕空檔，仍都低於 50 分鐘。每段開始前都以 SHA-pinned OIDC action 重取短效 access token，亂序與重跑錯段一律拒絕，且只有第 5 段做 exact restore 與最終完整 baseline 檢查。
4. 任一 segment 失敗或取消時，recovery job 以同一個 production Environment 執行 `restore-only`。復原遇到仍有效 lease 會重試；403 或非 `LEASE_BUSY` 錯誤立即 fail-closed。

GCS durable state 固定在 `runs/<run_id>/`：`manifest`、`checkpoint`、`intent`、`restore`、`terminal`、append-only `journal/*` 與 `canary-report`／`approval`。每次 mutation 前都會驗證 generation fencing；復原採 `current / post-image / pre-image` 三方比較，衝突轉為 `MANUAL_HOLD`，不覆寫協作者資料。artifact 不含 token、Spreadsheet ID 或 snapshot。

必備 GitHub Environment / repository 設定：

- Environment：`production`（不要設定 required reviewer，避免自動 recovery 被人工審核卡住；正式推演由單次 `workflow_dispatch` 明確啟動）。
- Variables：`GCP_WIF_PROVIDER`、`GCP_WIF_SERVICE_ACCOUNT`、`SOLAR_CUP_SPREADSHEET_ID`、`SOLAR_CUP_GCS_BUCKET`。
- Projection baselines：由 `autonomous-simulate.yml` 的 preflight／simulate／recovery job-level `env` 固定，不使用 repository secret，也不可由 dispatch input 覆寫。
- Projection hash 在計算前固定展開為 A:Z 矩形，將 REST 的空字串、`null` 與省略的尾端空白格／列視為同一個空白狀態。workflow 內的四組 baseline 必須由正式 Sheet 與原生備份各自以 `UNFORMATTED_VALUE` 計算，且四個 ID 全部逐一相同後才可更新。
- Google WIF attribute condition：只允許 `DeanSolar999/solarcup-info` 的 `main` 分支與 `workflow_dispatch`；agent 分支只供 PR review，不應取得 production OIDC。

workflow 會先檢查 `run_id` 格式，再取得 OIDC token；正式啟動前仍須確認 Environment variables、Sheet 分享權限與固定備份證據均有效。

## 淘汰賽晉級推導

`bracket.js` 解析 `bracket-tree.html` 的 `MNO` 取得賽程拓撲——哪一場屬於哪個五角形、
哪三場是三角循環，這是賽程的既成事實，不另抄一份以免兩邊漂移；解析失敗或場次數不符
132 一律 throw。`RR_PAIRS` / `TRI_PAIRS` 已隨 2026-08-12 雲端化改版從 HTML 刪除，
官方表定配對順序改由本檔常數 `OFFICIAL_RR_PAIRS` / `OFFICIAL_TRI_PAIRS` 承接
（內容與刪除前逐字相同，僅供離線工具使用）；HTML 若加回同名常數則以 HTML 為準，
`runtime-check.js` 與 `site-engine.test.js` 都會擋下這種靜默改源。

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
