"use strict";
// 練習模式純邏輯：出題、評分、選項產生、成績統計。不碰 DOM。
// 雙環境載入：瀏覽器 <script>（依賴 poker.js 與 gto.js 的全域函式，需先載入）
// + node require（測試用）。worker 不載此檔。

// 依賴取用：node 走 require；瀏覽器直接引用 gto.js 的全域。
// 注意不可用 var/let/const 重新宣告 gto.js 的名字（GTO_CHARTS 是 const 詞法綁定，重宣告會 SyntaxError）。
const _GTO = (typeof module !== "undefined" && module.exports)
  ? require("./gto.js")
  : { gtoLookup: gtoLookup, gtoChartMatrix: gtoChartMatrix, GTO_CHARTS: GTO_CHARTS };

const QUIZ_RANKS = "23456789TJQKA";
const QUIZ_SUITS = "shdc";

// ---- 牌面字串解析："As" = A♠、"Th" = T♥ ----

function quizParseCard(str) {
  const r = QUIZ_RANKS.indexOf(str[0]);
  const s = QUIZ_SUITS.indexOf(str[1]);
  if (r < 0 || s < 0) throw new Error("無法解析牌面: " + str);
  return s * 13 + r;
}

// 169 類手牌字串 → 兩張實際牌（suited 同花色，pair/offsuit 異花色）
function classToCards(cls, rng) {
  rng = rng || Math.random;
  const r1 = QUIZ_RANKS.indexOf(cls[0]);
  const r2 = QUIZ_RANKS.indexOf(cls[1]);
  if (r1 < 0 || r2 < 0) throw new Error("未知的手牌類別: " + cls);
  const s1 = (rng() * 4) | 0;
  if (cls[2] === "s") return [s1 * 13 + r1, s1 * 13 + r2];
  const s2 = (s1 + 1 + ((rng() * 3) | 0)) % 4;
  return [s1 * 13 + r1, s2 * 13 + r2];
}

// ---- 圖表情境列舉 ----

let _spotsCache = null;
function _allSpots() {
  if (_spotsCache) return _spotsCache;
  const out = [];
  for (const k in _GTO.GTO_CHARTS.RFI) {
    out.push({ chartType: "RFI", chartKey: k, heroPos: k, openerPos: null });
  }
  for (const k in _GTO.GTO_CHARTS.VS_RFI) {
    const m = k.split("_vs_");
    out.push({ chartType: "VS_RFI", chartKey: k, heroPos: m[0], openerPos: m[1] });
  }
  _spotsCache = out;
  return out;
}

// "RFI:UTG" / "VS_RFI:BB_vs_BTN" → 中文圖表標籤
function quizChartLabel(chartId) {
  const i = chartId.indexOf(":");
  const key = chartId.slice(i + 1);
  if (chartId.slice(0, i) === "RFI") return key + " 首入開池";
  const m = key.split("_vs_");
  return m[0] + " 對抗 " + m[1] + " 開池";
}

// ---- 有趣手牌集合：混合頻率類別 + 決策邊界類別 ----

function _primaryAction(strat) {
  let best = strat[0];
  for (const a of strat) if (a.freq > best.freq) best = a;
  return best.action;
}

const _interestingCache = {};
// 13×13 網格：以 rank 索引（12=A … 0=2）。對子在對角線，suited/offsuit 各佔一半。
function interestingClasses(chartType, chartKey) {
  const ck = chartType + ":" + chartKey;
  if (_interestingCache[ck]) return _interestingCache[ck];
  const matrix = _GTO.gtoChartMatrix(chartType, chartKey);
  if (!matrix) throw new Error("圖表不存在: " + ck);
  const cls = (hi, lo, su) => hi === lo
    ? QUIZ_RANKS[hi] + QUIZ_RANKS[lo]
    : QUIZ_RANKS[hi] + QUIZ_RANKS[lo] + (su ? "s" : "o");
  const set = {};
  const primary = (c) => _primaryAction(matrix[c]);
  for (const c in matrix) {
    if (matrix[c].length > 1) { set[c] = true; continue; } // 混合頻率必收
    // 純 100% 類別：同區域 4-鄰居主行動不同 → 決策邊界
    const hi = QUIZ_RANKS.indexOf(c[0]);
    const lo = QUIZ_RANKS.indexOf(c[1]);
    const neighbors = [];
    if (hi === lo) {
      if (hi < 12) neighbors.push(cls(hi + 1, hi + 1));
      if (hi > 0) neighbors.push(cls(hi - 1, hi - 1));
    } else {
      const su = c[2] === "s";
      if (hi + 1 <= 12 && hi + 1 > lo) neighbors.push(cls(hi + 1, lo, su));
      if (hi - 1 > lo) neighbors.push(cls(hi - 1, lo, su));
      if (lo + 1 < hi) neighbors.push(cls(hi, lo + 1, su));
      if (lo - 1 >= 0) neighbors.push(cls(hi, lo - 1, su));
    }
    // 鄰居是混合頻率、或主行動不同 → 此格緊鄰決策邊界
    const mine = primary(c);
    for (const n of neighbors) {
      if (matrix[n].length > 1 || primary(n) !== mine) { set[c] = true; break; }
    }
  }
  const out = Object.keys(set);
  _interestingCache[ck] = out;
  return out;
}

// 簡單牌池 = 全 169 類 − 有趣集合（離決策邊界遠的純策略牌），
// 按主行動分成 fold / act 兩桶——簡單題若均勻抽會幾乎都是無腦棄牌，出題時先抽桶再抽牌。
const _easyCache = {};
function easyClasses(chartType, chartKey) {
  const ck = chartType + ":" + chartKey;
  if (_easyCache[ck]) return _easyCache[ck];
  const matrix = _GTO.gtoChartMatrix(chartType, chartKey);
  const interesting = interestingClasses(chartType, chartKey);
  const out = { fold: [], act: [] };
  for (const c in matrix) {
    if (interesting.indexOf(c) >= 0) continue;
    (_primaryAction(matrix[c]) === "fold" ? out.fold : out.act).push(c);
  }
  _easyCache[ck] = out;
  return out;
}

// ---- 隨機出題 ----

// 回傳翻前決策題：{type, chartType, chartKey, heroPos, openerPos, handClass, cards, actions, strat}
function generatePreflopQuestion(rng) {
  rng = rng || Math.random;
  const spots = _allSpots();
  const spot = spots[(rng() * spots.length) | 0];
  let cls;
  if (rng() < 0.5) {
    const pool = interestingClasses(spot.chartType, spot.chartKey);
    cls = pool[(rng() * pool.length) | 0];
  } else {
    const all = Object.keys(_GTO.gtoChartMatrix(spot.chartType, spot.chartKey));
    cls = all[(rng() * all.length) | 0];
  }
  return {
    type: "preflop",
    chartType: spot.chartType, chartKey: spot.chartKey,
    heroPos: spot.heroPos, openerPos: spot.openerPos,
    handClass: cls,
    cards: classToCards(cls, rng),
    actions: spot.openerPos ? ["3bet", "call", "fold"] : ["raise", "call", "fold"],
    strat: _GTO.gtoLookup(spot.chartType, spot.chartKey, cls)
  };
}

// 回傳勝率估算題情境：{type, hero, board, oppCount}（答案由模擬算出）
function generateEquityScenario(rng) {
  rng = rng || Math.random;
  const deck = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  const boardLen = [0, 3, 4][(rng() * 3) | 0]; // 跳過 river：結果近乎二元，沒得估
  const need = 2 + boardLen;
  for (let i = 0; i < need; i++) {
    const j = i + ((rng() * (52 - i)) | 0);
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return {
    type: "equity",
    hero: [deck[0], deck[1]],
    board: deck.slice(2, need),
    oppCount: 1 + ((rng() * 3) | 0)
  };
}

// ---- 關卡（戰役模式）----
// 每關 10 題，得分 = 答對 + 0.5×部分正確；≥7 過關解鎖下一關。
// spec：kind（preflop/equity/mix）、chartType 或 heroPos 過濾圖表、
//       pool（easy=離邊界遠的純策略牌／interesting=混頻＋邊界牌）、
//       spacing（勝率選項間距）、oppCounts（對手數候選）。

const QUIZ_LEVELS = [
  { id: 1, title: "牛刀小試", tag: "勝率入門", desc: "估勝率，選項間距大，對手固定一位",
    count: 10, spec: { kind: "equity", spacing: 16, oppCounts: [1] } },
  { id: 2, title: "首入基礎", tag: "開池 or 棄牌", desc: "無人進池時該開就開、該丟就丟",
    count: 10, spec: { kind: "preflop", chartType: "RFI", pool: "easy" } },
  { id: 3, title: "防守基礎", tag: "面對開池", desc: "面對各位置開池的明確決策",
    count: 10, spec: { kind: "preflop", chartType: "VS_RFI", pool: "easy" } },
  { id: 4, title: "勝率進階", tag: "精算權益", desc: "選項間距縮小，最多三位對手",
    count: 10, spec: { kind: "equity", spacing: 8, oppCounts: [1, 2, 3] } },
  { id: 5, title: "首入進階", tag: "邊界手牌", desc: "全是開池範圍邊緣的難題",
    count: 10, spec: { kind: "preflop", chartType: "RFI", pool: "interesting" } },
  { id: 6, title: "防守進階", tag: "混合頻率", desc: "3-bet／跟注／棄牌的灰色地帶",
    count: 10, spec: { kind: "preflop", chartType: "VS_RFI", pool: "interesting" } },
  { id: 7, title: "盲位攻防", tag: "SB/BB 專精", desc: "只考盲位情境的邊界手牌",
    count: 10, spec: { kind: "preflop", heroPos: ["SB", "BB"], pool: "interesting" } },
  { id: 8, title: "綜合大考", tag: "全範圍", desc: "翻前難題與勝率精算混出",
    count: 10, spec: { kind: "mix", pool: "interesting", spacing: 8, oppCounts: [1, 2, 3] } }
];

function _levelSpots(spec) {
  return _allSpots().filter((sp) =>
    (!spec.chartType || sp.chartType === spec.chartType) &&
    (!spec.heroPos || spec.heroPos.indexOf(sp.heroPos) >= 0));
}

function _levelPreflopQuestion(spec, rng) {
  const spots = _levelSpots(spec);
  const spot = spots[(rng() * spots.length) | 0];
  let cls;
  if (spec.pool === "easy") {
    // 先 50/50 抽桶再抽牌：簡單池的棄牌桶遠大於行動桶，均勻抽會整關棄垃圾牌
    const buckets = easyClasses(spot.chartType, spot.chartKey);
    let bucket = rng() < 0.5 ? buckets.act : buckets.fold;
    if (!bucket.length) bucket = bucket === buckets.act ? buckets.fold : buckets.act;
    cls = bucket[(rng() * bucket.length) | 0];
  } else {
    const pool = interestingClasses(spot.chartType, spot.chartKey);
    cls = pool[(rng() * pool.length) | 0];
  }
  return {
    type: "preflop",
    chartType: spot.chartType, chartKey: spot.chartKey,
    heroPos: spot.heroPos, openerPos: spot.openerPos,
    handClass: cls,
    cards: classToCards(cls, rng),
    actions: spot.openerPos ? ["3bet", "call", "fold"] : ["raise", "call", "fold"],
    strat: _GTO.gtoLookup(spot.chartType, spot.chartKey, cls)
  };
}

// 依關卡 spec 出一題，形狀與 generatePreflopQuestion / generateEquityScenario 相同
//（equity 題多帶 spacing 供選項產生用）
function generateLevelQuestion(level, rng) {
  rng = rng || Math.random;
  const spec = level.spec;
  const kind = spec.kind === "mix" ? (rng() < 0.5 ? "preflop" : "equity") : spec.kind;
  if (kind === "preflop") return _levelPreflopQuestion(spec, rng);
  const q = generateEquityScenario(rng);
  if (spec.oppCounts) q.oppCount = spec.oppCounts[(rng() * spec.oppCounts.length) | 0];
  q.spacing = spec.spacing || 8;
  return q;
}

// 得分 → 星數：滿分 3 星、≥8.5 兩星、≥7 一星（過關）、否則 0
function quizLevelStars(score) {
  if (score >= 10) return 3;
  if (score >= 8.5) return 2;
  if (score >= 7) return 1;
  return 0;
}

// ---- 評分 ----

// 圖表頻率量化為 25/50/75/100：所選行動 freq ≥50 → correct、>0 → partial、0 → wrong
function gradePreflop(strat, chosenAction) {
  let freq = 0;
  for (const a of strat) if (a.action === chosenAction) freq = a.freq;
  if (freq >= 50) return "correct";
  if (freq > 0) return "partial";
  return "wrong";
}

// 四選一勝率百分點選項：含正解 round(E·100)，干擾項間隔至少 spacing 點（預設 8），範圍 [3,97]
function buildEquityOptions(equity, rng, spacing) {
  rng = rng || Math.random;
  const s = spacing || 8;
  const correct = Math.round(equity * 100);
  const offsets = [-2 * s, -s, s, 2 * s, 3 * s, -3 * s, 4 * s, -4 * s];
  for (let i = 3; i > 0; i--) { // 只打亂前四個基本偏移，後四個為補位備援
    const j = (rng() * (i + 1)) | 0;
    const t = offsets[i]; offsets[i] = offsets[j]; offsets[j] = t;
  }
  const opts = [correct];
  for (const off of offsets) {
    if (opts.length === 4) break;
    let v = correct + off;
    if (v < 3 || v > 97) v = correct - off;
    if (v < 3 || v > 97 || opts.indexOf(v) >= 0) continue;
    opts.push(v);
  }
  for (let i = opts.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = opts[i]; opts[i] = opts[j]; opts[j] = t;
  }
  return opts;
}

// 選到最接近實際勝率的選項即正確
function gradeEquity(options, chosenValue, equity) {
  const target = equity * 100;
  let best = options[0];
  for (const o of options) {
    if (Math.abs(o - target) < Math.abs(best - target)) best = o;
  }
  return chosenValue === best ? "correct" : "wrong";
}

// ---- 精選題庫 ----
// 翻前題只存情境＋解說，答案於出題時經 gtoLookup 查出（與圖表單一真相來源，不會漂移）。
// 勝率題的 answer 為 200k 次模擬結果，測試中會重新驗證（±2%）。

const QUIZ_BANK = [
  {
    id: "p01", type: "preflop", heroPos: "BB", openerPos: "BTN", handClass: "K9s",
    concept: "BB 防守寬度",
    explain: "BB 已被迫投入 1bb，面對 BTN 2.5bb 開池只需再跟 1.5bb 就能看翻牌，底池賠率約 26%，加上最後行動的資訊優勢，K9s 這種有同花與順子潛力的牌是標準防守跟注。BB 面對後位開池的防守範圍遠比直覺寬。"
  },
  {
    id: "p02", type: "preflop", heroPos: "SB", openerPos: "CO", handClass: "A4s",
    concept: "A 小同花 3-bet 詐唬",
    explain: "A4s 是經典的 3-bet 詐唬牌：手持一張 A 阻斷對手拿到 AA/AK 的組合數（阻斷牌效應），被跟注時還有同花與順子潛力。SB 沒位置又要面對翻後劣勢，平跟太弱、棄牌可惜，極化的 3-bet 是最佳選擇。"
  },
  {
    id: "p03", type: "preflop", heroPos: "UTG", openerPos: null, handClass: "A5s",
    concept: "A5s 首入開池",
    explain: "A5s 在最緊的 UTG 也是 100% 開池：A 阻斷對手強牌、可組成 A-5 輪盾順子、同花潛力佳，翻後可玩性遠勝 A9o 這類「看起來更大」的牌。注意 A8s~A6s 在 UTG 反而只有一半頻率開池——連結性比絕對大小重要。"
  },
  {
    id: "p04", type: "preflop", heroPos: "UTG", openerPos: null, handClass: "KJo",
    concept: "早位邊緣 offsuit",
    explain: "KJo 在 UTG 是典型的邊界牌：offsuit 缺乏同花潛力，被 3-bet 時很難受，翻中一對又常被 AJ/KQ 壓制（反向隱含賠率）。GTO 解是 50% 開池 50% 棄牌的混合策略——兩個行動 EV 幾乎相同，實戰中桌風緊就開、多人愛跟就丟。"
  },
  {
    id: "p05", type: "preflop", heroPos: "BTN", openerPos: "CO", handClass: "A9s",
    concept: "混合頻率 3-bet",
    explain: "BTN 面對 CO 開池，A9s 是 50/50 的 3-bet／跟注混合：牌力足以跟注，但拿來 3-bet 能利用位置優勢施壓，A 阻斷牌也讓詐唬更安全。混合策略的意義是讓對手無法從你的行動反推手牌範圍。"
  },
  {
    id: "p06", type: "preflop", heroPos: "BB", openerPos: "UTG", handClass: "ATo",
    concept: "offsuit 邊緣防守",
    explain: "ATo 面對最緊的 UTG 開池範圍很尷尬：翻中 A 常輸給 AJ+，翻中 T 牌力又不夠。GTO 只以 50% 頻率防守，另一半直接棄牌。同樣的牌面對 BTN 開池則是輕鬆跟注——對手範圍決定你的牌值多少。"
  },
  {
    id: "p07", type: "preflop", heroPos: "BTN", openerPos: "UTG", handClass: "22",
    concept: "口袋對 set-mine",
    explain: "小口袋對翻中暗三條的機率約 12%（約 7.5:1），跟注 2.5bb 賭的是中 set 後贏下對手 AA/KK/AK 頂對的大底池——隱含賠率遠超直接賠率。BTN 有位置保證翻後主導權，22 對抗 UTG 開池是標準跟注；3-bet 反而把自己變成詐唬。"
  },
  {
    id: "p08", type: "preflop", heroPos: "CO", openerPos: null, handClass: "54s",
    concept: "小同花連張偷盲",
    explain: "54s 在 CO 是 50% 頻率開池的邊界牌：同花連張有做出順子／同花的潛力，翻後可玩性好，但絕對牌力太弱，開太頻繁會被 3-bet 打爆。到了 BTN 這手牌就變成 100% 開池——越後位、偷盲成本越低。"
  },
  {
    id: "p09", type: "preflop", heroPos: "BB", openerPos: "SB", handClass: "Q5s",
    concept: "盲對盲寬防",
    explain: "SB 開池範圍是全桌最寬（近半數手牌），BB 有位置又已投入 1bb，防守範圍必須跟著變寬：Q5s 這種在其他情境直接棄掉的牌，盲對盲是標準跟注。面對越寬的範圍，你的防守範圍就要越寬。"
  },
  {
    id: "p10", type: "preflop", heroPos: "BTN", openerPos: null, handClass: "K5o",
    concept: "BTN 開池的底線",
    explain: "BTN 開池範圍雖然最寬（約 45%），但也有底線：K5o 只有 25% 頻率開池，大多數時候直接棄牌。offsuit 小 kicker 牌翻中 K 也常被壓制，翻不中就毫無出路。「BTN 什麼都能開」是常見的漏洞，不是策略。"
  },
  {
    id: "e01", type: "equity", hero: ["Ah", "Kh"], board: ["Qh", "Jh", "2c"], oppCount: 1,
    answer: 0.762, concept: "超級聽牌",
    explain: "堅果同花聽牌（9 outs）＋兩頭順聽（6 outs，扣除重複）＋兩張超對牌，合計約 17 outs 還沒中就已領先部分牌——這種「超級聽牌」對單一對手勝率高達七成六，翻牌全下也毫不吃虧。"
  },
  {
    id: "e02", type: "equity", hero: ["As", "Ad"], board: [], oppCount: 2,
    answer: 0.734, concept: "AA 的多人衰減",
    explain: "AA 單挑任意牌勝率約 85%，但每多一位對手就明顯衰減：對兩位約 73%。這就是 AA 要翻前大加注孤立對手的原因——人越多，最強起手牌的優勢被稀釋得越快。"
  },
  {
    id: "e03", type: "equity", hero: ["7h", "6h"], board: ["8s", "5c", "2d"], oppCount: 1,
    answer: 0.454, concept: "兩頭順聽的實力",
    explain: "兩頭順聽 8 outs，用 4-2 法則估轉牌＋河牌約 32% 成順，但別忘了 76 高牌本身偶爾也能贏、後門同花再補一點——對任意牌實際勝率約 45%，比「只算 outs」的直覺高不少。"
  },
  {
    id: "e04", type: "equity", hero: ["Qs", "Qd"], board: ["As", "7d", "2c"], oppCount: 1,
    answer: 0.780, concept: "超對牌面對超牌",
    explain: "翻牌出 A 讓 QQ 很緊張，但對「任意牌」對手仍有約 78% 勝率——對手只有約 1/6 的機率手上有 A。真正要修正的是對手範圍：若對手翻前有進池，其範圍含 A 比例大增，QQ 的處境就差得多。"
  },
  {
    id: "e05", type: "equity", hero: ["Kc", "Qc"], board: [], oppCount: 3,
    answer: 0.381, concept: "多人底池的權益",
    explain: "KQs 單挑任意牌約 60%，對三位對手只剩約 38%——但注意 38% 仍遠高於均分的 25%，多人底池中 KQs 依然是「賺錢」的牌，只是要有心理準備：多數時候會輸，靠贏的時候拿更多。"
  },
  {
    id: "e06", type: "equity", hero: ["Jh", "Th"], board: [], oppCount: 1,
    answer: 0.575, concept: "同花連張 vs 任意牌",
    explain: "JTs 是最強的非對子連張之一：能組成最多種順子（AKQJT 到 JT987），同花潛力完整。對任意牌約 57.5%，和 66 這種小對子單挑時也接近五五波——「小對子 vs 高連張」正是經典的擲硬幣局。"
  },
  {
    id: "e07", type: "equity", hero: ["As", "Ac"], board: ["9h", "8h", "7h"], oppCount: 1,
    answer: 0.602, concept: "危險牌面的 AA",
    explain: "同花色又連張的 9♥8♥7♥ 是 AA 最怕的牌面之一：對手任兩張紅心、任何 6 或 T 都已超車，勝率從翻前的 85% 掉到約 60%。強牌的價值取決於牌面——這也是「乾燥牌面下大注、濕潤牌面謹慎」的根源。"
  },
  {
    id: "e08", type: "equity", hero: ["2s", "2d"], board: [], oppCount: 1,
    answer: 0.501, concept: "最小對子的真相",
    explain: "22 對任意牌只有 50.3%——幾乎純擲硬幣。「有對子就領先」只在攤牌前成立：只要對手兩張超牌（機率極高），就是標準五五波；翻牌沒中 set（88% 的時候）幾乎打不下去。小對子的價值九成來自中 set 的隱含賠率。"
  }
];

// 題庫條目 → 與隨機出題相同形狀的題目物件（附 curatedId/concept/explain）
function curatedToQuestion(entry, rng) {
  if (entry.type === "preflop") {
    const chartType = entry.openerPos ? "VS_RFI" : "RFI";
    const chartKey = entry.openerPos ? entry.heroPos + "_vs_" + entry.openerPos : entry.heroPos;
    return {
      type: "preflop", curatedId: entry.id, concept: entry.concept, explain: entry.explain,
      chartType: chartType, chartKey: chartKey,
      heroPos: entry.heroPos, openerPos: entry.openerPos || null,
      handClass: entry.handClass,
      cards: classToCards(entry.handClass, rng),
      actions: entry.openerPos ? ["3bet", "call", "fold"] : ["raise", "call", "fold"],
      strat: _GTO.gtoLookup(chartType, chartKey, entry.handClass)
    };
  }
  return {
    type: "equity", curatedId: entry.id, concept: entry.concept, explain: entry.explain,
    hero: entry.hero.map(quizParseCard),
    board: entry.board.map(quizParseCard),
    oppCount: entry.oppCount,
    answer: entry.answer
  };
}

// ---- 成績統計（純 reducer，不改動輸入物件）----

function quizStatsInit() {
  return {
    v: 2, total: 0, correct: 0, partial: 0,
    byType: {},   // { preflop: {t,c,p}, equity: {t,c,p} }
    byChart: {},  // { "RFI:UTG": {t,c,p}, ... } 弱點分析用（僅翻前題）
    streak: 0, bestStreak: 0,
    seenCurated: [],
    history: [],  // {ts, type, key, result}，上限 100 筆
    campaign: { unlocked: 1, stars: {}, best: {} } // 關卡進度：stars/best 以 levelId 為鍵
  };
}

// localStorage 解析結果 → 現行 schema。v1 補 campaign 升 v2；認不得的輸入回 null（呼叫端重建）。
function quizStatsMigrate(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.v === 2) return parsed;
  if (parsed.v === 1) {
    const s = JSON.parse(JSON.stringify(parsed));
    s.v = 2;
    s.campaign = { unlocked: 1, stars: {}, best: {} };
    return s;
  }
  return null;
}

// 關卡結算（純 reducer）：best/stars 只升不降；本關 ≥7 分且正是最前緣關卡時解鎖下一關
function quizCampaignUpdate(stats, levelId, score) {
  const s = JSON.parse(JSON.stringify(stats));
  const c = s.campaign;
  const stars = quizLevelStars(score);
  if (!(c.best[levelId] >= score)) c.best[levelId] = score;
  if (!(c.stars[levelId] >= stars)) c.stars[levelId] = stars;
  if (score >= 7 && levelId === c.unlocked && c.unlocked < QUIZ_LEVELS.length) c.unlocked++;
  return s;
}

const QUIZ_HISTORY_MAX = 100;

// meta = {type, chartId?, key?, curatedId?, ts?}；result = "correct"|"partial"|"wrong"
function quizStatsUpdate(stats, meta, result) {
  const s = JSON.parse(JSON.stringify(stats));
  const bump = (obj, key) => {
    const b = obj[key] || (obj[key] = { t: 0, c: 0, p: 0 });
    b.t++;
    if (result === "correct") b.c++;
    else if (result === "partial") b.p++;
  };
  s.total++;
  if (result === "correct") {
    s.correct++;
    s.streak++;
    if (s.streak > s.bestStreak) s.bestStreak = s.streak;
  } else if (result === "partial") {
    s.partial++; // partial 不加連對也不歸零
  } else {
    s.streak = 0;
  }
  bump(s.byType, meta.type);
  if (meta.chartId) bump(s.byChart, meta.chartId);
  if (meta.curatedId && s.seenCurated.indexOf(meta.curatedId) < 0) {
    s.seenCurated.push(meta.curatedId);
  }
  s.history.push({ ts: meta.ts || 0, type: meta.type, key: meta.key || null, result: result });
  if (s.history.length > QUIZ_HISTORY_MAX) {
    s.history = s.history.slice(s.history.length - QUIZ_HISTORY_MAX);
  }
  return s;
}

// 答題 ≥5 且準確率 <60% 的圖表，依準確率升冪（accuracy = (c + 0.5p) / t）
function quizWeakSpots(stats) {
  const out = [];
  for (const key in stats.byChart) {
    const b = stats.byChart[key];
    if (b.t < 5) continue;
    const acc = (b.c + 0.5 * b.p) / b.t;
    if (acc < 0.6) out.push({ key: key, label: quizChartLabel(key), acc: acc, total: b.t });
  }
  out.sort((a, b) => a.acc - b.acc);
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    QUIZ_BANK, quizParseCard, classToCards, quizChartLabel,
    interestingClasses, easyClasses, generatePreflopQuestion, generateEquityScenario,
    QUIZ_LEVELS, generateLevelQuestion, quizLevelStars,
    gradePreflop, gradeEquity, buildEquityOptions, curatedToQuestion,
    quizStatsInit, quizStatsUpdate, quizWeakSpots, quizStatsMigrate, quizCampaignUpdate
  };
}
