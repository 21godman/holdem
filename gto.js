"use strict";
// 翻前 GTO 查表：近似公開的 100bb 6-max 現金桌 solver 翻前解（頻率量化到 25/50/75/100）。
// 與 poker.js 解耦：查表以 169 類手牌字串為鍵（"AA"/"AKs"/"AKo"，poker.js 的 handClass 產生）。
// 圖表編碼：每張圖 = 有序 [範圍spec, 策略碼] 陣列，「先匹配先贏」，未列出的手牌 = 100% 棄牌。
// spec 文法：對子 "TT"/"77+"/"TT-77"；非對子 "AKs"/"AJo"/"KQ"（未標=兩種花色型），
//   "ATs+"（同高牌向上）、"A9s-A2s"（同高牌下行）、"T9s-54s"（同間距下行）。dash 一律高→低。
// 策略碼：R(開池加注)/3B(3-bet)/C(跟注) + 整數頻率%（省略=100），餘數=棄牌。如 "3B60C40"。

const GTO_RANKS = "23456789TJQKA";

const GTO_SIZING = {
  rfiBB: { UTG: 2.5, MP: 2.5, CO: 2.5, BTN: 2.5, SB: 3 },
  threeBetIPFactor: 3,  // 有位置 3-bet 至開池額 3 倍
  threeBetOOPFactor: 4  // 沒位置 4 倍
};

// 翻後行動順序（判定 IP/OOP 用；翻前順序是 poker.js 的 POSITIONS）
const GTO_POSTFLOP_ORDER = ["SB", "BB", "UTG", "MP", "CO", "BTN"];

const GTO_CHARTS = {
  // ---- 首入開池（RFI）：前面全棄牌時，raise 或 fold ----
  RFI: {
    UTG: [
      ["66+, A9s+, A5s-A4s, KTs+, QTs+, JTs, T9s, AJo+, KQo", "R"],
      ["55-22, A8s-A6s, A3s-A2s, K9s, Q9s, J9s, 98s, ATo, KJo", "R50"]
    ],
    MP: [
      ["55+, A7s+, A5s-A4s, K9s+, QTs+, J9s+, T9s, 98s, ATo+, KJo+", "R"],
      ["44-22, A6s, A3s-A2s, K8s, Q9s, 87s, 76s, A9o, KTo, QJo", "R50"]
    ],
    CO: [
      ["22+, A2s+, K9s+, Q9s+, J9s+, T8s+, 98s-65s, ATo+, KTo+, QTo+, JTo", "R"],
      ["K8s-K6s, Q8s, T7s, 97s, 86s, 75s, 54s, A9o-A8o, K9o, Q9o, J9o, T9o", "R50"]
    ],
    BTN: [
      ["22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, 43s, A2o+, K9o+, Q9o+, J9o+, T8o+, 98o", "R"],
      ["Q4s-Q2s, J6s-J4s, T6s-T4s, 95s, 85s, 74s, 63s, 53s, K8o-K5o, Q8o, J8o, T7o, 97o, 87o, 76o, 65o", "R25"]
    ],
    SB: [
      ["22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 96s+, 85s+, 75s+, 64s+, 53s+, 43s, A2o+, K8o+, Q9o+, J8o+, T8o+, 98o, 87o", "R"],
      ["J3s-J2s, T5s-T4s, 95s, 84s, 74s, 63s, 52s, 42s, 32s, K7o-K5o, Q8o, J7o, T7o, 97o, 86o, 76o, 65o", "R25"]
    ]
    // BB 沒有「首入開池」情境
  },
  // ---- 面對開池加注：key = <守方>_vs_<開池方>，3bet / call / fold ----
  VS_RFI: {
    MP_vs_UTG: [
      ["QQ+, AKs, A5s, AKo", "3B"],
      ["JJ-TT, AQs, KQs", "3B50C50"],
      ["99-77, AJs-ATs, KJs, QJs, JTs, T9s, AQo", "C"],
      ["66-22, KTs, QTs, 98s", "C50"]
    ],
    CO_vs_UTG: [
      ["QQ+, AKs, A5s-A4s, AKo", "3B"],
      ["JJ-TT, AQs, KQs, AQo", "3B50C50"],
      ["99-55, AJs-ATs, KJs-KTs, QJs-QTs, JTs, T9s, 98s", "C"],
      ["44-22, A9s, 87s, 76s", "C50"]
    ],
    BTN_vs_UTG: [
      ["QQ+, AKs, A5s-A4s, AKo", "3B"],
      ["JJ-TT, AQs, KQs, AQo", "3B25C75"],
      ["99-22, AJs-ATs, KJs-KTs, QJs-QTs, JTs, T9s, 98s, 87s, 76s, 65s", "C"]
    ],
    SB_vs_UTG: [
      ["QQ+, AKs, AKo", "3B"],
      ["JJ-TT, AQs, A5s-A4s, KQs, AQo", "3B50"],
      ["99-77, AJs-ATs, KJs, QJs, JTs", "C50"]
    ],
    BB_vs_UTG: [
      ["QQ+, AKs, AKo", "3B75C25"],
      ["JJ, AQs, A5s-A2s, KQs, 65s-54s", "3B25C75"],
      ["TT-22, AJs-A6s, KJs-K9s, QJs-Q9s, JTs-J9s, T9s-T8s, 98s, 87s, 76s, AQo-AJo, KQo", "C"],
      ["K8s-K5s, Q8s, J8s, 97s, 86s, 75s, 64s, 53s, ATo, KJo, QJo", "C50"]
    ],
    CO_vs_MP: [
      ["QQ+, AKs, A5s-A4s, AKo", "3B"],
      ["JJ-TT, AQs, KQs, AQo", "3B50C50"],
      ["99-44, AJs-ATs, KJs-KTs, QJs-QTs, JTs, T9s, 98s, 87s", "C"],
      ["33-22, A9s, 76s, 65s", "C50"]
    ],
    BTN_vs_MP: [
      ["JJ+, AKs, A5s-A4s, AKo", "3B"],
      ["TT, AQs, A9s, KQs, AQo", "3B25C75"],
      ["99-22, AJs-ATs, KJs-KTs, QJs-QTs, JTs, T9s, 98s, 87s, 76s, 65s, 54s", "C"]
    ],
    SB_vs_MP: [
      ["JJ+, AKs, AKo", "3B"],
      ["TT-99, AQs-AJs, A5s-A4s, KQs, AQo", "3B50"],
      ["88-66, ATs, KJs, QJs, JTs, T9s", "C50"]
    ],
    BB_vs_MP: [
      ["JJ+, AKs, AKo", "3B75C25"],
      ["TT, AQs, A5s-A2s, KQs, 76s-54s", "3B25C75"],
      ["99-22, AJs-A6s, KJs-K9s, QJs-Q9s, JTs-J8s, T9s-T8s, 98s-97s, 87s, 76s, 65s, AQo-ATo, KQo-KJo", "C"],
      ["K8s-K4s, Q8s-Q7s, 86s, 75s, 64s, 53s, 43s, QJo, JTo", "C50"]
    ],
    BTN_vs_CO: [
      ["JJ+, AQs+, A5s-A4s, AKo", "3B"],
      ["TT-99, AJs, A9s, KQs, AQo, KQo", "3B50C50"],
      ["88-22, ATs, KJs-KTs, QJs-QTs, JTs, T9s, 98s, 87s, 76s, 65s, 54s, AJo", "C"]
    ],
    SB_vs_CO: [
      ["JJ+, AQs+, A5s-A4s, AKo", "3B"],
      ["TT-88, AJs-ATs, KQs-KJs, QJs, AQo, KQo", "3B50"],
      ["77-55, A9s, JTs, T9s", "C50"]
    ],
    BB_vs_CO: [
      ["QQ+, AJs+, A5s-A3s, KQs, AKo", "3B50C50"],
      ["JJ-99, ATs, KJs, QJs, 87s-54s, AQo", "3B25C75"],
      ["88-22, A9s-A2s, KTs-K7s, QTs-Q8s, JTs-J8s, T9s-T7s, 98s-96s, 86s, 75s, 65s-64s, AJo-A9o, KQo-KTo, QJo-QTo, JTo", "C"],
      ["K6s-K2s, Q7s-Q5s, J7s, 53s, 43s, A8o-A5o, K9o, Q9o, J9o, T9o", "C50"]
    ],
    SB_vs_BTN: [
      ["99+, ATs+, A5s-A4s, KQs-KJs, QJs, AJo+, KQo", "3B"],
      ["88-66, A9s-A8s, KTs, QTs, JTs, T9s, 98s, ATo", "3B50"],
      ["55-22, A7s-A2s, 87s, 76s", "C50"]
    ],
    BB_vs_BTN: [
      ["TT+, AJs+, A5s-A2s, KQs, AQo+", "3B50C50"],
      ["99-77, ATs-A9s, KJs-KTs, QJs, JTs, 76s-54s, AJo, KQo", "3B25C75"],
      ["66-22, A8s-A6s, K9s-K2s, QTs-Q4s, J9s-J6s, T9s-T6s, 98s-96s, 87s-85s, 75s-74s, 64s-63s, 53s, 43s, ATo-A2o, KJo-K9o, QJo-Q9o, JTo-J8o, T9o-T8o, 98o, 87o", "C"],
      ["Q3s-Q2s, J5s-J4s, T5s, 95s, 84s, K8o-K7o, Q8o, J7o, T7o, 97o, 76o, 65o", "C50"]
    ],
    BB_vs_SB: [
      ["99+, ATs+, A5s-A2s, KJs+, QJs, JTs, AJo+, KQo", "3B50C50"],
      ["88-66, A9s-A6s, KTs-K9s, QTs, T9s, 98s, 87s, ATo, KJo, QJo", "3B25C75"],
      ["55-22, K8s-K2s, Q9s-Q2s, J9s-J4s, T8s-T5s, 97s-95s, 86s-85s, 76s-74s, 65s-63s, 54s-53s, 43s-42s, 32s, A9o-A2o, KTo-K7o, QTo-Q8o, JTo-J7o, T9o-T7o, 98o-97o, 87o-86o, 76o, 65o", "C"]
    ]
  }
};

// ---- spec 解析 ----

function _rankIdx(ch) {
  const i = GTO_RANKS.indexOf(ch);
  if (i < 0) throw new Error("無法解析 GTO rank: " + ch);
  return i;
}

function _clsName(r1, r2, suited) {
  if (r1 === r2) return GTO_RANKS[r1] + GTO_RANKS[r2];
  return GTO_RANKS[r1] + GTO_RANKS[r2] + (suited ? "s" : "o");
}

// 單一 token → 類別字串陣列
function _expandToken(tok) {
  const out = [];
  const bad = () => { throw new Error("無法解析 GTO 範圍 token: " + tok); };
  const plus = tok.endsWith("+");
  const body = plus ? tok.slice(0, -1) : tok;
  const dash = body.indexOf("-");
  if (plus && dash >= 0) bad();
  const parsePart = (s) => {
    const m = /^([2-9TJQKA])([2-9TJQKA])([so])?$/.exec(s);
    if (!m) bad();
    return { hi: _rankIdx(m[1]), lo: _rankIdx(m[2]), su: m[3] || null };
  };
  const emit = (hi, lo, su) => {
    if (hi === lo) { out.push(_clsName(hi, lo)); return; }
    if (hi < lo) { const t = hi; hi = lo; lo = t; }
    if (su !== "o") out.push(_clsName(hi, lo, true));
    if (su !== "s") out.push(_clsName(hi, lo, false));
  };
  if (dash >= 0) {
    const a = parsePart(body.slice(0, dash));
    const b = parsePart(body.slice(dash + 1));
    if (a.su !== b.su) bad();
    if (a.hi === a.lo && b.hi === b.lo) {
      if (a.hi < b.hi) bad(); // 對子區間必須高→低，如 "TT-77"
      for (let r = a.hi; r >= b.hi; r--) emit(r, r);
    } else if (a.hi === b.hi) {
      if (a.lo < b.lo) bad(); // 同高牌下行，如 "A9s-A2s"
      for (let r = a.lo; r >= b.lo; r--) emit(a.hi, r, a.su);
    } else if (a.hi - a.lo === b.hi - b.lo) {
      if (a.hi < b.hi) bad(); // 同間距下行，如 "T9s-54s"
      for (let h = a.hi, l = a.lo; h >= b.hi; h--, l--) emit(h, l, a.su);
    } else bad();
  } else if (plus) {
    const p = parsePart(body);
    if (p.hi === p.lo) {
      for (let r = p.hi; r <= 12; r++) emit(r, r);
    } else {
      const hi = Math.max(p.hi, p.lo), lo = Math.min(p.hi, p.lo);
      for (let l = lo; l < hi; l++) emit(hi, l, p.su);
    }
  } else {
    const p = parsePart(body);
    emit(p.hi, p.lo, p.su);
  }
  return out;
}

// 整段 spec（逗號分隔）→ 類別字串陣列（供 compile 與測試用）
function _expandClasses(spec) {
  const out = [];
  for (const tok of spec.split(",")) {
    const t = tok.trim();
    if (t) out.push.apply(out, _expandToken(t));
  }
  return out;
}

// ---- 策略碼解析 ----

const _ACTION_NAMES = { "R": "raise", "3B": "3bet", "C": "call" };

function _parseStrategy(code) {
  if (!/^((?:3B|R|C)(?:\d+)?)+$/.test(code)) throw new Error("無法解析 GTO 策略碼: " + code);
  const re = /(3B|R|C)(\d*)/g;
  const out = [];
  let m, sum = 0;
  while ((m = re.exec(code)) !== null && m[0] !== "") {
    const freq = m[2] ? parseInt(m[2], 10) : 100;
    if (freq <= 0 || freq > 100) throw new Error("GTO 頻率超出範圍: " + code);
    out.push({ action: _ACTION_NAMES[m[1]], freq: freq });
    sum += freq;
  }
  if (sum > 100) throw new Error("GTO 頻率總和超過 100: " + code);
  if (sum < 100) out.push({ action: "fold", freq: 100 - sum });
  return out;
}

// ---- 編譯與查表 ----

let _allClassesCache = null;
function _allClasses() {
  if (_allClassesCache) return _allClassesCache;
  const out = [];
  for (let r1 = 12; r1 >= 0; r1--) {
    for (let r2 = r1; r2 >= 0; r2--) {
      if (r1 === r2) out.push(_clsName(r1, r2));
      else { out.push(_clsName(r1, r2, true)); out.push(_clsName(r1, r2, false)); }
    }
  }
  _allClassesCache = out;
  return out;
}

const _FOLD_ONLY = [{ action: "fold", freq: 100 }];
const _chartCache = {};

function _compile(chartType, chartKey) {
  const ck = chartType + ":" + chartKey;
  if (_chartCache[ck]) return _chartCache[ck];
  const group = GTO_CHARTS[chartType];
  const entries = group && group[chartKey];
  if (!entries) return null;
  const map = {};
  for (const pair of entries) {
    const strat = _parseStrategy(pair[1]);
    for (const cls of _expandClasses(pair[0])) {
      if (!(cls in map)) map[cls] = strat; // 先匹配先贏
    }
  }
  for (const cls of _allClasses()) {
    if (!(cls in map)) map[cls] = _FOLD_ONLY;
  }
  _chartCache[ck] = map;
  return map;
}

// 查一手牌在指定圖表的完整策略（含補滿的 fold）。圖表不存在 → null；未知類別 → throw。
// gtoLookup("RFI", "UTG", "AKs") → [{action:"raise", freq:100}]
function gtoLookup(chartType, chartKey, cls) {
  const map = _compile(chartType, chartKey);
  if (!map) return null;
  if (!(cls in map)) throw new Error("未知的手牌類別: " + cls);
  return map[cls];
}

// 回傳整張編譯後圖表（class → 策略陣列，169 鍵；勿修改）。供測試與 13×13 視覺化用。
function gtoChartMatrix(chartType, chartKey) {
  return _compile(chartType, chartKey);
}

// 一站式建議。opts = { handClass, heroPos, openerPos }（openerPos 省略/null = RFI）。
// 回傳 { chartType, chartKey, handClass, heroPos, openerPos, actions, inPosition, sizing }
//   actions：非零頻率、依 freq 降冪（同頻率保持進攻優先的撰寫順序）；primary = actions[0]。
// 找不到對應圖表（如 BB 首入、hero 在 opener 之前）→ null。
function gtoAdvise(opts) {
  const heroPos = opts.heroPos;
  const openerPos = opts.openerPos || null;
  const chartType = openerPos ? "VS_RFI" : "RFI";
  const chartKey = openerPos ? heroPos + "_vs_" + openerPos : heroPos;
  const strat = gtoLookup(chartType, chartKey, opts.handClass);
  if (!strat) return null;
  const actions = strat.filter(a => a.freq > 0).slice().sort((a, b) => b.freq - a.freq);
  let inPosition = null, sizing;
  if (openerPos) {
    inPosition = GTO_POSTFLOP_ORDER.indexOf(heroPos) > GTO_POSTFLOP_ORDER.indexOf(openerPos);
    sizing = { threeBetFactor: inPosition ? GTO_SIZING.threeBetIPFactor : GTO_SIZING.threeBetOOPFactor };
  } else {
    sizing = { rfiBB: GTO_SIZING.rfiBB[heroPos] };
  }
  return {
    chartType: chartType, chartKey: chartKey, handClass: opts.handClass,
    heroPos: heroPos, openerPos: openerPos,
    actions: actions, inPosition: inPosition, sizing: sizing
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GTO_CHARTS, GTO_SIZING, GTO_POSTFLOP_ORDER,
    gtoLookup, gtoChartMatrix, gtoAdvise,
    _expandClasses, _parseStrategy, _allClasses
  };
}
