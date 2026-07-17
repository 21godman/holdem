"use strict";
// 練習模式邏輯測試：出題產生器、評分、選項、成績 reducer、精選題庫驗證
// 執行：node test/quiz.test.js

const {
  QUIZ_BANK, quizParseCard, classToCards, quizChartLabel,
  interestingClasses, easyClasses, generatePreflopQuestion, generateEquityScenario,
  QUIZ_LEVELS, generateLevelQuestion, quizLevelStars,
  gradePreflop, gradeEquity, buildEquityOptions, curatedToQuestion,
  quizStatsInit, quizStatsUpdate, quizWeakSpots, quizStatsMigrate, quizCampaignUpdate
} = require("../quiz.js");
const { GTO_CHARTS, gtoAdvise, gtoChartMatrix } = require("../gto.js");
const { makeSim, handClass, POSITIONS } = require("../poker.js");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}

// 可重現的偽隨機（LCG），出題測試用
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

console.log("== 牌面解析與類別轉換 ==");
assert(quizParseCard("As") === 12, "As = 12");
assert(quizParseCard("2s") === 0, "2s = 0");
assert(quizParseCard("Th") === 13 + 8, "Th = 21");
assert(quizParseCard("Ac") === 39 + 12, "Ac = 51");
{
  const rng = makeRng(1);
  for (const cls of ["AA", "AKs", "AKo", "72o", "T9s"]) {
    for (let i = 0; i < 20; i++) {
      const cards = classToCards(cls, rng);
      assert(handClass(cards[0], cards[1]) === cls,
        "classToCards(" + cls + ") 往返應一致，得到 " + handClass(cards[0], cards[1]));
      assert(cards[0] !== cards[1], cls + " 兩張牌不得相同");
    }
  }
}

console.log("== 有趣手牌集合 ==");
{
  for (const key in GTO_CHARTS.RFI) {
    const pool = interestingClasses("RFI", key);
    assert(pool.length > 0, "RFI:" + key + " 有趣集合不得為空");
    const matrix = gtoChartMatrix("RFI", key);
    for (const cls in matrix) {
      if (matrix[cls].length > 1) {
        assert(pool.indexOf(cls) >= 0, "RFI:" + key + " 混合頻率類別 " + cls + " 應在有趣集合中");
      }
    }
  }
  for (const key in GTO_CHARTS.VS_RFI) {
    assert(interestingClasses("VS_RFI", key).length > 0, "VS_RFI:" + key + " 有趣集合不得為空");
  }
  // 邊界案例：UTG RFI 中 66 是 100% 開池、55 是 50%——66 是純策略但緊鄰混合區，應屬邊界
  assert(interestingClasses("RFI", "UTG").indexOf("66") >= 0, "66 應為 RFI:UTG 的邊界類別");
}

console.log("== 翻前出題產生器 ==");
{
  const rng = makeRng(42);
  const allClasses = Object.keys(gtoChartMatrix("RFI", "UTG"));
  let sawRFI = false, sawVsRFI = false;
  for (let i = 0; i < 500; i++) {
    const q = generatePreflopQuestion(rng);
    assert(q.type === "preflop", "題型應為 preflop");
    assert(GTO_CHARTS[q.chartType] && GTO_CHARTS[q.chartType][q.chartKey] !== undefined,
      "圖表應存在: " + q.chartType + ":" + q.chartKey);
    assert(allClasses.indexOf(q.handClass) >= 0, "手牌類別應合法: " + q.handClass);
    assert(handClass(q.cards[0], q.cards[1]) === q.handClass,
      "cards 應對應 handClass: " + q.handClass);
    assert(Array.isArray(q.strat) && q.strat.length >= 1, "strat 應為非空陣列");
    assert(q.actions.length === 3 && q.actions.indexOf("fold") >= 0, "應有三個選項且含棄牌");
    if (q.openerPos) {
      sawVsRFI = true;
      assert(POSITIONS.indexOf(q.heroPos) > POSITIONS.indexOf(q.openerPos),
        "VS_RFI 守方必須在開池方之後: " + q.chartKey);
      assert(q.actions[0] === "3bet", "面對開池第一選項應為 3bet");
    } else {
      sawRFI = true;
      assert(q.heroPos !== "BB", "BB 沒有首入開池情境");
      assert(q.actions[0] === "raise", "首入第一選項應為 raise");
    }
  }
  assert(sawRFI && sawVsRFI, "500 次出題應涵蓋 RFI 與 VS_RFI 兩種情境");
}

console.log("== 勝率出題產生器 ==");
{
  const rng = makeRng(7);
  for (let i = 0; i < 500; i++) {
    const q = generateEquityScenario(rng);
    const cards = q.hero.concat(q.board);
    assert([0, 3, 4].indexOf(q.board.length) >= 0, "公牌數應為 0/3/4，得到 " + q.board.length);
    assert(q.oppCount >= 1 && q.oppCount <= 3, "對手數應為 1–3");
    assert(new Set(cards).size === cards.length, "發牌不得重複");
    for (const c of cards) assert(c >= 0 && c <= 51 && c === (c | 0), "牌值應為 0–51 整數");
  }
}

console.log("== 翻前評分 ==");
{
  const pure = [{ action: "raise", freq: 100 }];
  assert(gradePreflop(pure, "raise") === "correct", "100% raise 選 raise → correct");
  assert(gradePreflop(pure, "fold") === "wrong", "100% raise 選 fold → wrong");
  assert(gradePreflop(pure, "call") === "wrong", "100% raise 選 call（limp 陷阱）→ wrong");
  const mixed5050 = [{ action: "3bet", freq: 50 }, { action: "call", freq: 50 }];
  assert(gradePreflop(mixed5050, "3bet") === "correct", "3B50C50 選 3bet → correct");
  assert(gradePreflop(mixed5050, "call") === "correct", "3B50C50 選 call → correct");
  assert(gradePreflop(mixed5050, "fold") === "wrong", "3B50C50 選 fold → wrong");
  const low = [{ action: "call", freq: 25 }, { action: "fold", freq: 75 }];
  assert(gradePreflop(low, "call") === "partial", "C25 選 call → partial");
  assert(gradePreflop(low, "fold") === "correct", "C25 選 fold → correct");
  const trash = [{ action: "fold", freq: 100 }];
  assert(gradePreflop(trash, "fold") === "correct", "垃圾牌選 fold → correct");
  assert(gradePreflop(trash, "raise") === "wrong", "垃圾牌選 raise → wrong");
}

console.log("== 勝率選項與評分 ==");
{
  const rng = makeRng(99);
  for (const eq of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
    for (let i = 0; i < 50; i++) {
      const opts = buildEquityOptions(eq, rng);
      assert(opts.length === 4, "應有 4 個選項（equity=" + eq + "）");
      assert(new Set(opts).size === 4, "選項不得重複");
      assert(opts.indexOf(Math.round(eq * 100)) >= 0, "應含正解 " + Math.round(eq * 100));
      const sorted = opts.slice().sort((a, b) => a - b);
      for (let k = 1; k < 4; k++) {
        assert(sorted[k] - sorted[k - 1] >= 8, "選項間隔應 ≥8: " + sorted.join(","));
      }
      for (const o of opts) assert(o >= 3 && o <= 97, "選項應在 [3,97]: " + o);
      assert(gradeEquity(opts, Math.round(eq * 100), eq) === "correct", "選正解應 correct");
      const wrongOpt = opts.filter((o) => o !== Math.round(eq * 100))[0];
      assert(gradeEquity(opts, wrongOpt, eq) === "wrong", "選錯應 wrong");
    }
  }
  // 可重現性：同 seed 應產生同選項
  const a = buildEquityOptions(0.5, makeRng(3));
  const b = buildEquityOptions(0.5, makeRng(3));
  assert(a.join(",") === b.join(","), "同 seed 選項應可重現");
}

console.log("== 成績 reducer ==");
{
  const s0 = quizStatsInit();
  const frozen = JSON.stringify(s0);
  const meta = (type, chartId) => ({ type: type, chartId: chartId || null, key: "k", ts: 1 });
  let s = quizStatsUpdate(s0, meta("preflop", "RFI:UTG"), "correct");
  assert(JSON.stringify(s0) === frozen, "reducer 不得改動輸入物件");
  s = quizStatsUpdate(s, meta("preflop", "RFI:UTG"), "correct");
  assert(s.total === 2 && s.correct === 2 && s.streak === 2 && s.bestStreak === 2, "兩連對統計正確");
  s = quizStatsUpdate(s, meta("preflop", "RFI:UTG"), "partial");
  assert(s.partial === 1 && s.streak === 2, "partial 不歸零連對");
  assert(s.bestStreak === 2, "partial 不增加連對");
  s = quizStatsUpdate(s, meta("equity"), "wrong");
  assert(s.streak === 0 && s.bestStreak === 2, "答錯歸零連對、保留最佳");
  assert(s.byType.preflop.t === 3 && s.byType.equity.t === 1, "byType 分項統計");
  assert(s.byChart["RFI:UTG"].t === 3 && s.byChart["RFI:UTG"].c === 2, "byChart 分項統計");
  // seenCurated 去重
  s = quizStatsUpdate(s, { type: "preflop", curatedId: "p01" }, "correct");
  s = quizStatsUpdate(s, { type: "preflop", curatedId: "p01" }, "correct");
  assert(s.seenCurated.length === 1 && s.seenCurated[0] === "p01", "seenCurated 應去重");
  // history 上限 100
  let big = quizStatsInit();
  for (let i = 0; i < 130; i++) big = quizStatsUpdate(big, meta("equity"), "correct");
  assert(big.history.length === 100, "history 應上限 100，得到 " + big.history.length);
  assert(big.total === 130, "total 不受 history 上限影響");
  // 弱點分析：≥5 題且準確率 <60%
  let w = quizStatsInit();
  for (let i = 0; i < 5; i++) w = quizStatsUpdate(w, meta("preflop", "VS_RFI:BB_vs_BTN"), "wrong");
  for (let i = 0; i < 5; i++) w = quizStatsUpdate(w, meta("preflop", "RFI:BTN"), "correct");
  for (let i = 0; i < 4; i++) w = quizStatsUpdate(w, meta("preflop", "RFI:SB"), "wrong");
  const spots = quizWeakSpots(w);
  assert(spots.length === 1 && spots[0].key === "VS_RFI:BB_vs_BTN", "只有 ≥5 題且 <60% 的圖表列為弱點");
  assert(spots[0].label === "BB 對抗 BTN 開池", "弱點標籤格式");
  assert(quizChartLabel("RFI:UTG") === "UTG 首入開池", "RFI 標籤格式");
}

console.log("== 關卡結構 ==");
{
  assert(QUIZ_LEVELS.length === 8, "應有 8 關");
  QUIZ_LEVELS.forEach((lv, i) => {
    assert(lv.id === i + 1, "關卡 id 應連號: " + lv.id);
    assert(lv.count === 10, "每關 10 題");
    assert(lv.title && lv.tag && lv.desc, "第 " + lv.id + " 關需有標題／副標／說明");
    assert(["preflop", "equity", "mix"].indexOf(lv.spec.kind) >= 0, "spec.kind 合法");
  });
  // 簡單牌池：兩桶皆非空（每張會被簡單關卡用到的圖表）
  for (const key in GTO_CHARTS.RFI) {
    const b = easyClasses("RFI", key);
    assert(b.fold.length > 0 && b.act.length > 0, "RFI:" + key + " 簡單池兩桶皆非空");
  }
  for (const key in GTO_CHARTS.VS_RFI) {
    const b = easyClasses("VS_RFI", key);
    assert(b.fold.length > 0 && b.act.length > 0, "VS_RFI:" + key + " 簡單池兩桶皆非空");
    const inter = interestingClasses("VS_RFI", key);
    for (const c of b.fold.concat(b.act)) {
      if (inter.indexOf(c) >= 0) { assert(false, "VS_RFI:" + key + " 簡單池不得含有趣牌: " + c); break; }
    }
  }
}

console.log("== 關卡出題規格 ==");
{
  for (const lv of QUIZ_LEVELS) {
    const rng = makeRng(lv.id * 1000 + 1);
    let sawPreflop = 0, sawEquity = 0;
    for (let i = 0; i < 200; i++) {
      const q = generateLevelQuestion(lv, rng);
      if (q.type === "preflop") {
        sawPreflop++;
        const spec = lv.spec;
        assert(spec.kind !== "equity", "第 " + lv.id + " 關不該出翻前題");
        if (spec.chartType) assert(q.chartType === spec.chartType, "第 " + lv.id + " 關圖表類型應為 " + spec.chartType);
        if (spec.heroPos) assert(spec.heroPos.indexOf(q.heroPos) >= 0, "第 " + lv.id + " 關 heroPos 應限 " + spec.heroPos);
        const inter = interestingClasses(q.chartType, q.chartKey);
        if (spec.pool === "easy") {
          assert(inter.indexOf(q.handClass) < 0, "第 " + lv.id + " 關簡單池不得出邊界牌: " + q.handClass);
        } else {
          assert(inter.indexOf(q.handClass) >= 0, "第 " + lv.id + " 關困難池應出邊界/混頻牌: " + q.handClass);
        }
        assert(handClass(q.cards[0], q.cards[1]) === q.handClass, "cards 對應類別");
      } else {
        sawEquity++;
        assert(lv.spec.kind !== "preflop", "第 " + lv.id + " 關不該出勝率題");
        assert(q.spacing === (lv.spec.spacing || 8), "第 " + lv.id + " 關 spacing 應為 " + lv.spec.spacing);
        if (lv.spec.oppCounts) assert(lv.spec.oppCounts.indexOf(q.oppCount) >= 0, "第 " + lv.id + " 關對手數限制");
      }
    }
    if (lv.spec.kind === "mix") assert(sawPreflop > 30 && sawEquity > 30, "綜合關兩種題型都要出現");
  }
  // spacing=16 的選項最小間隔 ≥16
  const rng = makeRng(11);
  for (const eq of [0.2, 0.5, 0.8]) {
    for (let i = 0; i < 30; i++) {
      const opts = buildEquityOptions(eq, rng, 16);
      const sorted = opts.slice().sort((a, b) => a - b);
      assert(opts.length === 4, "spacing 16 仍應 4 選項");
      for (let k = 1; k < 4; k++) assert(sorted[k] - sorted[k - 1] >= 16, "間隔應 ≥16: " + sorted.join(","));
      for (const o of opts) assert(o >= 3 && o <= 97, "選項應在 [3,97]: " + o);
    }
  }
}

console.log("== 星等與關卡進度 ==");
{
  assert(quizLevelStars(6.5) === 0, "6.5 分 0 星（未過關）");
  assert(quizLevelStars(7) === 1, "7 分 1 星");
  assert(quizLevelStars(8) === 1, "8 分 1 星");
  assert(quizLevelStars(8.5) === 2, "8.5 分 2 星");
  assert(quizLevelStars(9.5) === 2, "9.5 分 2 星");
  assert(quizLevelStars(10) === 3, "10 分 3 星");

  const s0 = quizStatsInit();
  assert(s0.v === 2 && s0.campaign.unlocked === 1, "初始 schema v2、解鎖第 1 關");
  const frozen = JSON.stringify(s0);
  let s = quizCampaignUpdate(s0, 1, 8.5);
  assert(JSON.stringify(s0) === frozen, "campaign reducer 不得改動輸入");
  assert(s.campaign.unlocked === 2 && s.campaign.stars[1] === 2 && s.campaign.best[1] === 8.5, "過關解鎖並記星");
  s = quizCampaignUpdate(s, 1, 7); // 重打低分
  assert(s.campaign.stars[1] === 2 && s.campaign.best[1] === 8.5, "星星與 best 只升不降");
  assert(s.campaign.unlocked === 2, "重打已過的關不再推進解鎖");
  s = quizCampaignUpdate(s, 5, 10); // 打還沒解鎖到的關（防禦：不跳關解鎖）
  assert(s.campaign.unlocked === 2, "非前緣關卡不得推進解鎖");
  assert(s.campaign.stars[5] === 3, "但星星照記");
  s = quizCampaignUpdate(s, 2, 6.5); // 未達標
  assert(s.campaign.unlocked === 2, "未達 7 分不解鎖");
  for (let id = 2; id <= 8; id++) s = quizCampaignUpdate(s, id, 10);
  assert(s.campaign.unlocked === 8, "全破後 unlocked 停在 8（無第 9 關）");
}

console.log("== schema 遷移 ==");
{
  const v1 = {
    v: 1, total: 42, correct: 30, partial: 4,
    byType: { preflop: { t: 20, c: 15, p: 2 } }, byChart: { "RFI:UTG": { t: 5, c: 3, p: 0 } },
    streak: 3, bestStreak: 9, seenCurated: ["p01"], history: [{ ts: 1, type: "preflop", key: "AKs", result: "correct" }]
  };
  const m = quizStatsMigrate(v1);
  assert(m.v === 2 && m.total === 42 && m.bestStreak === 9 && m.seenCurated[0] === "p01", "v1 升 v2 保留原統計");
  assert(m.campaign.unlocked === 1 && Object.keys(m.campaign.stars).length === 0, "v1 升 v2 補初始 campaign");
  assert(v1.v === 1 && !v1.campaign, "遷移不改動輸入物件");
  const v2 = quizStatsInit();
  assert(quizStatsMigrate(v2) === v2, "v2 原樣通過");
  assert(quizStatsMigrate(null) === null, "null → null");
  assert(quizStatsMigrate("junk") === null, "字串 → null");
  assert(quizStatsMigrate({ v: 99 }) === null, "未知版本 → null");
}

console.log("== 精選題庫驗證 ==");
{
  const ids = new Set();
  const rng = makeRng(5);
  for (const entry of QUIZ_BANK) {
    assert(!ids.has(entry.id), "題庫 id 不得重複: " + entry.id);
    ids.add(entry.id);
    assert(typeof entry.explain === "string" && entry.explain.length >= 20,
      entry.id + " 解說不得為空且需有實質內容");
    assert(typeof entry.concept === "string" && entry.concept.length > 0, entry.id + " 需有概念標籤");
    if (entry.type === "preflop") {
      const g = gtoAdvise({
        handClass: entry.handClass,
        heroPos: entry.heroPos,
        openerPos: entry.openerPos || null
      });
      assert(g !== null, entry.id + " 應能對應到 GTO 圖表");
      const q = curatedToQuestion(entry, rng);
      assert(q.strat.length >= 1 && q.curatedId === entry.id, entry.id + " curatedToQuestion 形狀");
      assert(handClass(q.cards[0], q.cards[1]) === entry.handClass, entry.id + " cards 對應類別");
    } else {
      const hero = entry.hero.map(quizParseCard);
      const board = entry.board.map(quizParseCard);
      const all = hero.concat(board);
      assert(new Set(all).size === all.length, entry.id + " 牌面不得重複");
      const sim = makeSim(hero, board, entry.oppCount);
      const counters = { win: 0, tie: 0, lose: 0, equity: 0, total: 0 };
      sim.run(100000, counters);
      const eq = counters.equity / counters.total;
      assert(Math.abs(eq - entry.answer) < 0.02,
        entry.id + " 預存答案 " + entry.answer + " 應與模擬 " + eq.toFixed(4) + " 相差 <2%");
    }
  }
  const preflopCount = QUIZ_BANK.filter((e) => e.type === "preflop").length;
  const equityCount = QUIZ_BANK.filter((e) => e.type === "equity").length;
  assert(preflopCount >= 8 && equityCount >= 6, "題庫應涵蓋兩種題型（翻前 " + preflopCount + "、勝率 " + equityCount + "）");
}

console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
