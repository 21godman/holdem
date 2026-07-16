# CLAUDE.md

德州撲克勝率計算器 — 純前端 PWA，零依賴、無建置步驟、無框架。介面為繁體中文。

## 常用指令

```bash
node .claude/serve.js          # 開發伺服器 → http://localhost:8642（python3 http.server 在此機器被沙盒擋住，勿用）
node test/evaluator.test.js    # 36 項測試：評牌器 + 勝率基準對照，改過 poker.js 後必跑
```

## 架構

- `poker.js` — 唯一的核心邏輯檔，同時被三種環境載入：瀏覽器 `<script>`（全域函式）、`worker.js` 的 `importScripts`、node 測試的 `require`（檔尾有 `module.exports`）。改動時三邊都要相容。除評牌與模擬外，還有：`expandRangeSpec`（"22+, ATs+" 範圍字串 → 組合陣列）、`POSITION_RANGES`/`getPresetRange`（各位置預設開牌範圍，展開結果有模組層級快取）、`adviseBet`（規則式下注建議，非 GTO）。
- `worker.js` — Web Worker 包裝，分批（每批 10,000 次）跑模擬並回報進度；以遞增的 job id 取消過期任務。訊息協定：`{id, hero, board, opponents: [{range, folded}], iterations}`；棄牌者在 worker 端過濾掉，舊的 `numOpp` 數字協定仍相容。`app.js` 的 `mainThreadSim` 有一份相同邏輯，兩邊要同步改。
- `app.js` — 全部 UI 狀態與 DOM 操作。Worker 建立失敗時自動退回主執行緒分批模擬（`mainThreadSim`）。
- `sw.js` — cache-first 離線快取。**改動任何靜態檔後要把 `CACHE` 版本字串遞增**（如 `poker-equity-v1` → `v2`），否則已安裝的 PWA 拿到舊快取。

## 核心慣例

- 牌 = 0–51 整數：`rank = card % 13`（0 = 2 … 12 = A），`suit = (card / 13) | 0`（0♠ 1♥ 2♦ 3♣）。紅色花色是 suit 1 和 2。
- `evaluate(cards, len)` 接受 5–7 張牌，回傳可直接比大小的整數：`(牌型類別 << 20) | kickers`（每個 rank 佔 4 bits）。用了模組層級的 scratch array（`_rankCount`/`_suitCount`），非 reentrant——單執行緒環境下安全，勿在並行情境共用。
- `makeSim(hero, board, opponents)` 的 `opponents` 可為數字（N 位任意牌）或陣列（每項為組合陣列，null = 任意牌）。範圍對手用 rejection sampling 抽手牌（撞牌重抽，100 次後退回隨機發）；建立時就先剔除與已知牌衝突的組合。`counters.equity` 已含平手均分（tie 時加 `1/(tied+1)`）。

## 部署（GitHub Pages）

正式網址：https://21godman.github.io/holdem/ （repo: `21godman/holdem`，deploy from branch）
push 到 `main` 即自動重新部署，無 CI/workflow。全站路徑皆為相對路徑，子路徑部署不需改碼。
記得：改動任何會被 SW 快取的靜態檔後遞增 `sw.js` 的 `CACHE` 版本（見上），否則已安裝的 PWA 更新不到。
