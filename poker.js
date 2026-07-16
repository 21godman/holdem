"use strict";
// 德州撲克核心邏輯：牌的表示、7 張牌評牌器、蒙地卡羅模擬
// 牌用 0–51 整數表示：rank = card % 13（0=2 … 12=A），suit = (card / 13) | 0

const RANK_CHARS = "23456789TJQKA";
const SUIT_CHARS = ["♠", "♥", "♦", "♣"];
const HAND_NAMES = ["高牌", "一對", "兩對", "三條", "順子", "同花", "葫蘆", "四條", "同花順"];

function cardText(c) {
  return RANK_CHARS[c % 13] + SUIT_CHARS[(c / 13) | 0];
}

// 兩張牌 → 169 類手牌字串："AA"、"AKs"、"AKo"（高 rank 在前）
function handClass(c1, c2) {
  let r1 = c1 % 13, r2 = c2 % 13;
  if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
  if (r1 === r2) return RANK_CHARS[r1] + RANK_CHARS[r2];
  return RANK_CHARS[r1] + RANK_CHARS[r2] + (((c1 / 13) | 0) === ((c2 / 13) | 0) ? "s" : "o");
}

// 回傳順子的最大 rank（含 A-5 wheel），沒有順子回傳 -1
function straightHigh(rankMask) {
  for (let hi = 12; hi >= 4; hi--) {
    if (((rankMask >> (hi - 4)) & 31) === 31) return hi;
  }
  // A-5 wheel：A(12) + 2,3,4,5(0..3)
  return ((rankMask & 15) === 15 && (rankMask & 4096)) ? 3 : -1;
}

// 評 5–7 張牌，回傳可直接比大小的整數分數：(類別 << 20) | kickers（每個 rank 4 bits）
const _rankCount = new Uint8Array(13);
const _suitCount = new Uint8Array(4);

function evaluate(cards, len) {
  _rankCount.fill(0);
  _suitCount.fill(0);
  let rankMask = 0;
  for (let i = 0; i < len; i++) {
    const c = cards[i];
    _rankCount[c % 13]++;
    _suitCount[(c / 13) | 0]++;
    rankMask |= 1 << (c % 13);
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (_suitCount[s] >= 5) flushSuit = s;
  if (flushSuit >= 0) {
    let mask = 0;
    for (let i = 0; i < len; i++) {
      const c = cards[i];
      if (((c / 13) | 0) === flushSuit) mask |= 1 << (c % 13);
    }
    const sf = straightHigh(mask);
    if (sf >= 0) return (8 << 20) | (sf << 16);
    let kick = 0, n = 0;
    for (let r = 12; r >= 0 && n < 5; r--) if (mask & (1 << r)) { kick = (kick << 4) | r; n++; }
    return (5 << 20) | kick;
  }

  let quad = -1, trips = -1, trips2 = -1, pair1 = -1, pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = _rankCount[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (trips < 0) trips = r; else if (trips2 < 0) trips2 = r; }
    else if (n === 2) { if (pair1 < 0) pair1 = r; else if (pair2 < 0) pair2 = r; }
  }

  if (quad >= 0) {
    let k = -1;
    for (let r = 12; r >= 0; r--) if (r !== quad && _rankCount[r]) { k = r; break; }
    return (7 << 20) | (quad << 16) | (k << 12);
  }
  if (trips >= 0 && (trips2 >= 0 || pair1 >= 0)) {
    const p = trips2 > pair1 ? trips2 : pair1;
    return (6 << 20) | (trips << 16) | (p << 12);
  }
  const st = straightHigh(rankMask);
  if (st >= 0) return (4 << 20) | (st << 16);
  if (trips >= 0) {
    let kick = 0, n = 0;
    for (let r = 12; r >= 0 && n < 2; r--) if (_rankCount[r] && r !== trips) { kick = (kick << 4) | r; n++; }
    return (3 << 20) | (trips << 16) | (kick << 8);
  }
  if (pair2 >= 0) {
    // 七張牌可能出現三個對子，kicker 要在兩個最大對子以外的所有牌裡取最大
    let k = -1;
    for (let r = 12; r >= 0; r--) if (_rankCount[r] && r !== pair1 && r !== pair2) { k = r; break; }
    return (2 << 20) | (pair1 << 16) | (pair2 << 12) | (k << 8);
  }
  if (pair1 >= 0) {
    let kick = 0, n = 0;
    for (let r = 12; r >= 0 && n < 3; r--) if (_rankCount[r] && r !== pair1) { kick = (kick << 4) | r; n++; }
    return (1 << 20) | (pair1 << 16) | (kick << 4);
  }
  let kick = 0, n = 0;
  for (let r = 12; r >= 0 && n < 5; r--) if (_rankCount[r]) { kick = (kick << 4) | r; n++; }
  return kick;
}

function handName(score) {
  return HAND_NAMES[score >> 20];
}

// ---- 手牌範圍：以 "22+, ATs+, KQo" 這類字串表示，展開成具體兩張牌組合 ----

// 把單一 token 的所有花色組合推進 out：對子 6 組、同花 4 組、雜色 12 組
function _pushCombos(out, r1, r2, suitedness) {
  if (r1 === r2) {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([s1 * 13 + r1, s2 * 13 + r1]);
    return;
  }
  if (suitedness !== "o") {
    for (let s = 0; s < 4; s++) out.push([s * 13 + r1, s * 13 + r2]);
  }
  if (suitedness !== "s") {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([s1 * 13 + r1, s2 * 13 + r2]);
  }
}

// 展開範圍字串。支援：對子 "TT"、"77+"；非對子 "AKs"/"AJo"/"T9s"，
// 加 "+" 表示第二張 rank 一路升到第一張之下（如 "ATs+" = ATs AJs AQs AKs）。
function expandRangeSpec(spec) {
  const out = [];
  for (const raw of spec.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = /^([2-9TJQKA])([2-9TJQKA])([so])?(\+)?$/.exec(tok);
    if (!m) throw new Error("無法解析範圍 token: " + tok);
    let r1 = RANK_CHARS.indexOf(m[1]);
    let r2 = RANK_CHARS.indexOf(m[2]);
    const suitedness = m[3] || "";
    const plus = !!m[4];
    if (r1 < r2) { const t = r1; r1 = r2; r2 = t; }
    if (r1 === r2) {
      const top = plus ? 12 : r1;
      for (let r = r1; r <= top; r++) _pushCombos(out, r, r, "");
    } else {
      const top = plus ? r1 - 1 : r2;
      for (let r = r2; r <= top; r++) _pushCombos(out, r1, r, suitedness);
    }
  }
  return out;
}

// 各位置的預設範圍（參考常見 6-max GTO 開牌圖表的簡化版；RANDOM = 任意兩張）
const POSITION_RANGES = {
  UTG_OPEN: "66+, A9s+, KTs+, QTs+, JTs, T9s, ATo+, KJo+",
  MP_OPEN: "55+, A7s+, A5s, KTs+, QTs+, J9s+, T9s, 98s, ATo+, KJo+, QJo",
  CO_OPEN: "22+, A2s+, K9s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, 65s, A9o+, KTo+, QTo+, JTo",
  BTN_OPEN: "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+, K9o+, Q9o+, J9o+, T9o, 98o",
  SB_OPEN: "22+, A2s+, K2s+, Q2s+, J5s+, T6s+, 96s+, 85s+, 75s+, 64s+, 53s+, 43s, A2o+, K8o+, Q9o+, J9o+, T8o+, 98o, 87o",
  BB_DEFEND: "22+, A2s+, K5s+, Q7s+, J7s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A5o+, K9o+, Q9o+, J9o+, T9o, 98o"
};

const _presetCache = {};
// 取預設範圍的展開結果（模組層級快取）；"RANDOM" 或未知名稱回傳 null（= 任意兩張）
function getPresetRange(name) {
  if (!name || name === "RANDOM" || !POSITION_RANGES[name]) return null;
  if (!_presetCache[name]) _presetCache[name] = expandRangeSpec(POSITION_RANGES[name]);
  return _presetCache[name];
}

// 建立一場模擬：hero 兩張、board 0–5 張。
// opponents 可為數字（N 位任意牌對手，舊介面）或陣列（每項為該對手的組合陣列，null = 任意牌）。
// 回傳的 run(iterations, counters) 可分批呼叫，counters 累計 win/tie/lose/equity/total
function makeSim(heroCards, boardCards, opponents) {
  const known = new Set(heroCards.concat(boardCards));
  const deck = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) deck.push(c);
  const hand = new Uint8Array(7);

  // 正規化對手：先剔除各範圍中與已知牌衝突的組合；剔光了就退回任意牌
  const rawRanges = typeof opponents === "number" ? new Array(opponents).fill(null) : opponents;
  const numOpp = rawRanges.length;
  const ranges = rawRanges.map((r) => {
    if (!r) return null;
    const f = r.filter((cb) => !known.has(cb[0]) && !known.has(cb[1]));
    return f.length ? f : null;
  });

  const used = new Uint8Array(52);   // 本迭代已被範圍對手拿走的牌
  const usedList = new Uint8Array(numOpp * 2);
  const oppHole = new Int16Array(numOpp * 2); // -1 = 這位對手改從牌堆隨機發

  return {
    run(iterations, counters) {
      for (let it = 0; it < iterations; it++) {
        // 1. 範圍對手先抽手牌：從組合陣列隨機取，撞牌就重抽（上限 100 次後退回隨機發）
        let usedN = 0;
        for (let o = 0; o < numOpp; o++) {
          const list = ranges[o];
          oppHole[o * 2] = -1;
          if (!list) continue;
          for (let t = 0; t < 100; t++) {
            const cb = list[(Math.random() * list.length) | 0];
            if (!used[cb[0]] && !used[cb[1]]) {
              used[cb[0]] = used[cb[1]] = 1;
              usedList[usedN++] = cb[0];
              usedList[usedN++] = cb[1];
              oppHole[o * 2] = cb[0];
              oppHole[o * 2 + 1] = cb[1];
              break;
            }
          }
        }

        // 2. 其餘從牌堆發：部分 Fisher–Yates，跳過已被範圍對手拿走的牌
        let di = 0;
        const draw = () => {
          for (;;) {
            const j = di + ((Math.random() * (deck.length - di)) | 0);
            const t = deck[di]; deck[di] = deck[j]; deck[j] = t;
            const c = deck[di++];
            if (!used[c]) return c;
          }
        };

        hand[0] = heroCards[0];
        hand[1] = heroCards[1];
        for (let b = 0; b < boardCards.length; b++) hand[2 + b] = boardCards[b];
        for (let b = boardCards.length; b < 5; b++) hand[2 + b] = draw();
        const heroScore = evaluate(hand, 7);

        let beaten = false, tied = 0;
        for (let o = 0; o < numOpp; o++) {
          let c0 = oppHole[o * 2];
          let c1;
          if (c0 < 0) { c0 = draw(); c1 = draw(); }
          else c1 = oppHole[o * 2 + 1];
          hand[0] = c0;
          hand[1] = c1;
          const s = evaluate(hand, 7);
          if (s > heroScore) { beaten = true; break; }
          if (s === heroScore) tied++;
        }

        for (let i = 0; i < usedN; i++) used[usedList[i]] = 0;

        if (beaten) counters.lose++;
        else if (tied) { counters.tie++; counters.equity += 1 / (tied + 1); }
        else { counters.win++; counters.equity += 1; }
      }
      counters.total += iterations;
    }
  };
}

// ---- 下注建議：純規則式（equity 對比底池賠率 + 位置 + 人數），非 GTO 精解 ----

const POSITIONS = ["UTG", "MP", "CO", "BTN", "SB", "BB"];
const _LATE = { CO: 1, BTN: 1 }; // 大多數情況下有位置優勢

// 輸入 {equity, potSize, toCall, position, numActiveOpp, street}
// 回傳 {action, sizePct, requiredEquity, reason}
// action: "fold" | "check" | "call" | "bet" | "raise"；sizePct 為建議下注佔底池 %
function adviseBet(opts) {
  const eq = opts.equity;
  const numOpp = Math.max(1, opts.numActiveOpp | 0);
  const inPosition = !!_LATE[opts.position];
  const potSize = opts.potSize > 0 ? opts.potSize : 0;
  const toCall = opts.toCall > 0 ? opts.toCall : 0;
  const river = opts.street === "river";
  const pct = (x) => (x * 100).toFixed(1) + "%";

  // 多人底池門檻上調：每多一位對手 +4%；有位置略降 2%
  const adj = 0.04 * (numOpp - 1) - (inPosition ? 0.02 : 0);

  if (toCall > 0) {
    const required = toCall / (potSize + toCall);
    if (eq < required) {
      return {
        action: "fold", sizePct: null, requiredEquity: required,
        reason: "勝率 " + pct(eq) + " 低於跟注所需的 " + pct(required) + "，跟注不划算"
      };
    }
    if (eq >= 0.62 + adj) {
      return {
        action: "raise", sizePct: 100, requiredEquity: required,
        reason: "勝率 " + pct(eq) + " 明顯領先，建議加注（約一個底池）取得價值"
      };
    }
    return {
      action: "call", sizePct: null, requiredEquity: required,
      reason: "勝率 " + pct(eq) + " 高於跟注所需的 " + pct(required) + "，跟注划算"
    };
  }

  // 沒人下注：看牌力決定主動下注與尺度
  if (eq >= 0.78 + adj) {
    return {
      action: "bet", sizePct: 75, requiredEquity: 0,
      reason: "牌力極強（勝率 " + pct(eq) + "），建議下大注 3/4 底池取得最大價值"
    };
  }
  if (eq >= 0.60 + adj) {
    return {
      action: "bet", sizePct: 60, requiredEquity: 0,
      reason: "牌力領先（勝率 " + pct(eq) + "），建議下注約 6 成底池" + (river ? "取價值" : "取價值兼保護")
    };
  }
  if (eq >= 0.48 + adj && inPosition && !river) {
    return {
      action: "bet", sizePct: 33, requiredEquity: 0,
      reason: "小幅領先且有位置，建議小注 1/3 底池施壓"
    };
  }
  return {
    action: "check", sizePct: null, requiredEquity: 0,
    reason: "勝率 " + pct(eq) + " 不足以主動下注，建議過牌控制底池"
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RANK_CHARS, SUIT_CHARS, HAND_NAMES, POSITIONS, POSITION_RANGES,
    cardText, handClass, evaluate, handName, makeSim, straightHigh,
    expandRangeSpec, getPresetRange, adviseBet
  };
}
