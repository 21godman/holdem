# CLAUDE.md

德州撲克勝率計算器 — 純前端 PWA，零依賴、無建置步驟、無框架。介面為繁體中文。

## 常用指令

```bash
node .claude/serve.js          # 開發伺服器 → http://localhost:8642（python3 http.server 在此機器被沙盒擋住，勿用）
node test/evaluator.test.js    # 89 項測試：評牌器 + 勝率基準 + GTO 圖表驗證，改過 poker.js 或 gto.js 後必跑
node test/quiz.test.js         # 練習模式測試：出題產生器 + 評分 + 成績 reducer + 題庫驗證，改過 quiz.js 或 gto.js 圖表後必跑
```

## 架構

- `poker.js` — 唯一的核心邏輯檔，同時被三種環境載入：瀏覽器 `<script>`（全域函式）、`worker.js` 的 `importScripts`、node 測試的 `require`（檔尾有 `module.exports`）。改動時三邊都要相容。除評牌與模擬外，還有：`expandRangeSpec`（"22+, ATs+" 範圍字串 → 組合陣列）、`POSITION_RANGES`/`getPresetRange`（各位置預設開牌範圍，展開結果有模組層級快取）、`adviseBet`（規則式下注建議，翻後與圖表對應不到時用）、`handClass`（兩張牌 → "AKs" 等 169 類字串）。
- `gto.js` — 翻前 GTO 查表（近似公開 100bb 6-max 現金桌解，頻率量化到 25/50/75/100）。雙環境載入：瀏覽器 `<script>` + node `require`（worker 不載，別依賴 poker.js）。圖表編碼：有序 `[範圍spec, 策略碼]` 陣列，**先匹配先贏**，未列出 = 100% 棄牌；spec 文法支援 dash 下行（`"A9s-A2s"`、`"T9s-54s"`），與 poker.js 的 `expandRangeSpec` 是不同解析器。改過圖表資料後必跑測試——結構驗證會抓被遮蔽的 entry 與頻率錯誤。
- `worker.js` — Web Worker 包裝，分批（每批 10,000 次）跑模擬並回報進度；以遞增的 job id 取消過期任務。訊息協定：`{id, hero, board, opponents: [{range, folded}], iterations}`；棄牌者在 worker 端過濾掉，舊的 `numOpp` 數字協定仍相容。`app.js` 的 `mainThreadSim` 有一份相同邏輯，兩邊要同步改。
- `app.js` — 全部 UI 狀態與 DOM 操作。Worker 建立失敗時自動退回主執行緒分批模擬（`mainThreadSim`）。翻前建議優先走 gto.js 查表：`detectPreflopScenario` 從現有 UI 推斷情境（待跟額 0 → 首入；待跟額 >0 且恰一位未棄牌對手選了位置開池範圍 → 面對該位置開池），對應不到圖表才退回 `adviseBet` 並在註記標明。
- `quiz.js` — 練習模式純邏輯（不碰 DOM）：翻前決策出題（`generatePreflopQuestion`，50% 抽「有趣集合」＝混頻＋決策邊界類別）、勝率估算出題（`generateEquityScenario`）、評分（`gradePreflop`：freq ≥50 correct／>0 partial／0 wrong；`gradeEquity`：選最接近實際勝率的選項）、精選題庫 `QUIZ_BANK`（翻前題答案出題時經 gtoLookup 查出，不預存；勝率題預存答案由測試對照模擬驗證 ±2%）、成績純 reducer（`quizStatsInit/Update/WeakSpots/Migrate`）。**關卡制**：`QUIZ_LEVELS`（8 關，主題×難度雙軸）、`generateLevelQuestion`（按 spec 過濾圖表與牌池；簡單池 = `easyClasses` 兩桶先 50/50 抽桶再抽牌，否則整關都是無腦棄牌）、`quizLevelStars`（≥7 一星過關、≥8.5 兩星、滿分三星）、`quizCampaignUpdate`（best/stars 只升不降、前緣關卡達標才解鎖）。`buildEquityOptions(equity, rng, spacing)` 第三參數控制選項間距（預設 8，簡單關 16）。雙環境載入：瀏覽器 `<script>` + node `require`。**注意**：依賴 gto.js 一律走檔頭的 `_GTO` 物件取用，不可用 var/let/const 重新宣告 gto.js 的全域名（`GTO_CHARTS` 是 const 詞法綁定，瀏覽器端重宣告會 SyntaxError 導致整檔載入失敗）。
- `quiz-ui.js` — 練習模式 UI（IIFE，載於 app.js 之後）。三子視圖狀態機：`#quizHome`（關卡地圖＋自由練習入口＋統計＋重設鈕）→ `#quizPlay`（答題，關卡模式頂列顯示進度與得分）→ `#quizResultView`（結算：星星、錯題回顧、重打／下一關）。與 app.js 完全獨立：**自己持有第二個 Worker 實例**與 jobId 計數（沿用 worker.js 既有協定），失敗時退回主執行緒分批模擬。勝率題以 50k 次模擬出答案後才開放作答。精選題庫只在自由練習出現。成績存 localStorage key `holdemQuizV1`（schema `v:2` 含 `campaign`；讀取經 `quizStatsMigrate` 遷移 v1，認不得才重建；讀寫皆包 try/catch）。模式切換：`#modeBtn` 切 `#calcView`/`#quizView` 的 hidden ＋ `body.quiz` class。
- `sw.js` — cache-first 離線快取。**改動任何靜態檔後要把 `CACHE` 版本字串遞增**（如 `poker-equity-v1` → `v2`），否則已安裝的 PWA 拿到舊快取。

## 核心慣例

- 牌 = 0–51 整數：`rank = card % 13`（0 = 2 … 12 = A），`suit = (card / 13) | 0`（0♠ 1♥ 2♦ 3♣）。紅色花色是 suit 1 和 2。
- `evaluate(cards, len)` 接受 5–7 張牌，回傳可直接比大小的整數：`(牌型類別 << 20) | kickers`（每個 rank 佔 4 bits）。用了模組層級的 scratch array（`_rankCount`/`_suitCount`），非 reentrant——單執行緒環境下安全，勿在並行情境共用。
- `makeSim(hero, board, opponents)` 的 `opponents` 可為數字（N 位任意牌）或陣列（每項為組合陣列，null = 任意牌）。範圍對手用 rejection sampling 抽手牌（撞牌重抽，100 次後退回隨機發）；建立時就先剔除與已知牌衝突的組合。`counters.equity` 已含平手均分（tie 時加 `1/(tied+1)`）。

## 部署（GitHub Pages）

正式網址：https://21godman.github.io/holdem/ （repo: `21godman/holdem`，deploy from branch）
push 到 `main` 即自動重新部署，無 CI/workflow。全站路徑皆為相對路徑，子路徑部署不需改碼。
記得：改動任何會被 SW 快取的靜態檔後遞增 `sw.js` 的 `CACHE` 版本（見上），否則已安裝的 PWA 更新不到。
