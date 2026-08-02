# Solar Cup 模擬 Runner

這是獨立的後端測試 runner。預設 `dry-run` 使用 mock adapter，沒有 Google API 寫入，也不讀取或保存任何 credential。

```bash
cd '/Users/dean/Desktop/solar cup賽務資訊網站/simulation'
npm test
npm run check
mkdir -p /private/tmp/solarcup-sim && touch /private/tmp/solarcup-sim/OBSERVER_READY
node runner.js dry-run --fast --state-dir /private/tmp/solarcup-sim --run-id demo
# 結果為 CANARY_WAITING_APPROVAL；確認 Browser observer 後才放行：
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
- 預設資格賽為 `2_資格賽成績!K2:L151`；比分只生成 `21 : 0–19`，無平手。

目前限制：Google Sheets REST API 的 `batchUpdate` 沒有 spreadsheet revision CAS。runner 以 `userEnteredValue` canonical hash read-before-write、寫後 readback evidence 與三方 restore comparison 降低風險，但不能取代真正的資料庫交易鎖。

armed gate 的 LIVE switch 固定讀取 `0_賽事設定!B12 = 0`；`B11` 是總場次，`B13` 是最後更新時間，兩者均不得作為 LIVE gate。

armed mode 必須明確提供 `SOLAR_CUP_SPREADSHEET_ID`、`GOOGLE_ACCESS_TOKEN`、`SOLAR_CUP_GCS_BUCKET` 與 `SOLAR_CUP_PROJECTION_BASELINES`。後者只能是固定範圍的 SHA-256 hash map，例如 `{"3":"<64 位 hex hash>","6":"<64 位 hex hash>","7":"<64 位 hex hash>","8":"<64 位 hex hash>"}`；範圍由程式鎖定為 `3:A1:Z109`、`6:A1:Z109`、`7:A1:Z11`、`8:A1:Z311`，環境變數無法覆寫。runner 以 GCS JSON API 的 object generation 作 fencing；少任一環境變數或 baseline 都 fail-closed。

正式 resume 不沿用已釋放的 canary lease。runner 會先取得新 lease、把新的 `fencing_token` 與 `manifest_hash` 寫入 manifest／journal，並在持有該 lease 的 90 秒內等待 Browser 寫入 `canary-observed` 與 `canary-approved` JSON marker。兩個 marker 都必須帶相同的 `run_id`、新 token、manifest hash 與未過期 `expires_at`；逾時即 fail-closed。

Marker 只能寫入 `simulation/runs/` 下的既有 run，且會驗證 manifest hash：

```bash
node marker.js observer-heartbeat --state-dir ./runs --run-id sim-... \
  --fencing-token <token> --manifest-hash <hash> --ttl-seconds 60
```
