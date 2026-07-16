"use strict";
// 評牌器單元測試 + 蒙地卡羅勝率基準對照
// 執行：node test/evaluator.test.js

const { evaluate, handName, makeSim, expandRangeSpec, getPresetRange, adviseBet } = require("../poker.js");

// "As" = A♠、"Th" = T♥；花色 s=♠ h=♥ d=♦ c=♣
const RANKS = "23456789TJQKA";
const SUITS = "shdc";
function card(str) {
  const r = RANKS.indexOf(str[0]);
  const s = SUITS.indexOf(str[1]);
  if (r < 0 || s < 0) throw new Error("bad card: " + str);
  return s * 13 + r;
}
function hand(str) {
  return str.trim().split(/\s+/).map(card);
}
function score(str) {
  const h = hand(str);
  return evaluate(h, h.length);
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}
function assertName(cards, expected) {
  const s = score(cards);
  assert(handName(s) === expected, cards + " 應為 " + expected + "，實際 " + handName(s));
}
function assertGT(a, b, msg) {
  assert(score(a) > score(b), msg + "（" + a + " 應勝過 " + b + "）");
}
function assertEQ(a, b, msg) {
  assert(score(a) === score(b), msg + "（" + a + " 應平手 " + b + "）");
}

console.log("== 牌型辨識 ==");
assertName("As Ks Qs Js Ts 2d 7c", "同花順");   // 皇家
assertName("9s 8s 7s 6s 5s Ad Ac", "同花順");
assertName("As 5s 4s 3s 2s Kd Qc", "同花順");   // 同花順 wheel
assertName("As Ah Ad Ac Kd 2s 7h", "四條");
assertName("As Ah Ad Ks Kd 2s 7h", "葫蘆");
assertName("As Ah Ad Ks Kd Kc 7h", "葫蘆");     // 兩組三條取葫蘆
assertName("As Qs 9s 5s 2s Kd Kc", "同花");
assertName("9s 8d 7c 6h 5s Ad Ac", "順子");
assertName("As Kd Qc Jh Ts 2s 2d", "順子");
assertName("Ah 2s 3d 4c 5h Kd Qc", "順子");     // wheel
assertName("As Ah Ad Ks Qd 2s 7h", "三條");
assertName("As Ah Ks Kd Qc 2s 7h", "兩對");
assertName("As Ah Ks Qd Jc 2s 7h", "一對");
assertName("As Ks Qd Jc 9h 2s 7h", "高牌");

console.log("== 牌型大小全序 ==");
assertGT("As Ks Qs Js Ts 2d 7c", "9s 8s 7s 6s 5s Ad Kc", "皇家同花順 > 較小同花順");
assertGT("9s 8s 7s 6s 5s 2d 7c", "As Ah Ad Ac Kd 2s 7h", "同花順 > 四條");
assertGT("As Ah Ad Ac 2d 3s 7h", "As Ah Ad Ks Kd 2s 7h", "四條 > 葫蘆");
assertGT("2s 2h 2d 3s 3d 7c 8h", "As Qs 9s 5s 2s Kd Kc", "葫蘆 > 同花");
assertGT("2s 4s 6s 8s Ts Ad Kc", "As Kd Qc Jh Ts 2s 3d", "同花 > 順子");
assertGT("2s 3d 4c 5h 6s Kd Qc", "As Ah Ad Ks Qd 2s 7h", "順子 > 三條");
assertGT("2s 2h 2d Ks Qd 7c 8h", "As Ah Ks Kd Qc 2s 7h", "三條 > 兩對");
assertGT("2s 2h 3s 3d Ac 7c 8h", "As Ah Ks Qd Jc 2s 7h", "兩對 > 一對");
assertGT("2s 2h Ks Qd Jc 7c 8h", "As Ks Qd Jc 9h 2s 7h", "一對 > 高牌");

console.log("== 踢腳與邊界 ==");
assertGT("6s 5d 4c 3h 2s Kd Qc", "Ah 2s 3d 4c 5h Kd Qc", "6 高順子 > wheel");
assertGT("As Ah Kd Qc Jh 2s 7h", "As Ad Kd Qc Th 2s 7h", "同對子比踢腳 J > T");
assertGT("As Ah Ks Kd Qc 2s 7h", "As Ah Ks Kd Jc 2s 7h", "兩對比踢腳 Q > J");
assertGT("As Ah Ks Kd 2c 2s 7h", "As Ah Qs Qd Kc 2s 7h", "兩對先比第二對 K > Q");
// 三個對子：kicker 取第三對的 rank（Q > 7）
assertGT("As Ah Ks Kd Qc Qs 2h", "As Ah Ks Kd 7c 7s 2h", "三對子時第三對做踢腳");
assertEQ("As Kd Qc Jh 9s 3d 2c", "Ah Ks Qd Jc 9h 3s 2d", "同 rank 不同花高牌平手");
assertEQ("2s 7h As Kd Qc Jh Ts", "3c 8d Ah Ks Qd Jc Th", "公板順子大家平分");

console.log("== 範圍展開 ==");
assert(expandRangeSpec("AA").length === 6, "AA 應為 6 組");
assert(expandRangeSpec("AKs").length === 4, "AKs 應為 4 組");
assert(expandRangeSpec("AKo").length === 12, "AKo 應為 12 組");
assert(expandRangeSpec("AK").length === 16, "AK（未指定花色）應為 16 組");
assert(expandRangeSpec("22+").length === 78, "22+ 應為 13 對子 × 6 = 78 組");
assert(expandRangeSpec("ATs+").length === 16, "ATs+ = ATs AJs AQs AKs = 16 組");
assert(expandRangeSpec("QQ+, AKs").length === 22, "QQ+, AKs 應為 18 + 4 = 22 組");
{
  // 所有組合都是兩張不同的合法牌
  const all = expandRangeSpec("22+, A2s+, K2s+, A2o+");
  assert(all.every(([a, b]) => a !== b && a >= 0 && a < 52 && b >= 0 && b < 52), "展開組合皆為兩張相異合法牌");
}
{
  // 預設範圍：越後面的位置範圍越寬
  const n = (name) => getPresetRange(name).length;
  assert(n("UTG_OPEN") < n("MP_OPEN"), "UTG 範圍應比 MP 緊");
  assert(n("MP_OPEN") < n("CO_OPEN"), "MP 範圍應比 CO 緊");
  assert(n("CO_OPEN") < n("BTN_OPEN"), "CO 範圍應比 BTN 緊");
  assert(n("BTN_OPEN") <= n("SB_OPEN"), "BTN 範圍應不寬於 SB");
  assert(n("SB_OPEN") < 1326, "SB 範圍應小於全部 1326 組");
  assert(getPresetRange("RANDOM") === null, "RANDOM 應回傳 null（任意兩張）");
}

console.log("== 勝率基準（蒙地卡羅 200,000 次）==");
function equity(heroStr, boardStr, opponents, iters) {
  const counters = { win: 0, tie: 0, lose: 0, equity: 0, total: 0 };
  makeSim(hand(heroStr), boardStr ? hand(boardStr) : [], opponents).run(iters, counters);
  return counters.equity / counters.total;
}
function assertEquity(label, actual, expected, tol) {
  const pct = (x) => (x * 100).toFixed(1) + "%";
  assert(Math.abs(actual - expected) <= tol,
    label + "：期望 " + pct(expected) + " ±" + pct(tol) + "，實際 " + pct(actual));
  console.log("  " + label + " → " + pct(actual) + "（參考值 " + pct(expected) + "）");
}
const N = 200000;
assertEquity("AA 對 1 位隨機對手（翻牌前）", equity("As Ah", "", 1, N), 0.852, 0.01);
assertEquity("KK 對 1 位隨機對手（翻牌前）", equity("Ks Kh", "", 1, N), 0.824, 0.01);
assertEquity("72o 對 1 位隨機對手（翻牌前）", equity("7s 2h", "", 1, N), 0.346, 0.01);
assertEquity("AA 對 8 位隨機對手（翻牌前）", equity("As Ah", "", 8, N), 0.347, 0.01);
assertEquity("河牌堅果（皇家同花順）", equity("As Ks", "Ts Js Qs 2d 7c", 3, 50000), 1.0, 0.0001);
// 公板即最大牌：全員平分，equity = 1/(對手+1)
assertEquity("公板皇家同花順 3 位對手平分", equity("2s 7h", "Ad Kd Qd Jd Td", 3, 50000), 0.25, 0.0001);

console.log("== 範圍對手勝率 ==");
// KK 對指定 AA 範圍（唯一被 hero 阻斷剩下的組合仍是 AA）：精算約 18%
assertEquity("KK 對 AA 範圍", equity("Ks Kh", "", [expandRangeSpec("AA")], N), 0.180, 0.015);
// QJs 對 UTG 緊範圍應明顯低於對任意牌
{
  const vsRandom = equity("Qs Js", "", 1, N);
  const vsUTG = equity("Qs Js", "", [getPresetRange("UTG_OPEN")], N);
  const pct = (x) => (x * 100).toFixed(1) + "%";
  assert(vsUTG < vsRandom - 0.05, "QJs 對 UTG 範圍（" + pct(vsUTG) + "）應明顯低於對任意牌（" + pct(vsRandom) + "）");
  console.log("  QJs 對任意牌 → " + pct(vsRandom) + "，對 UTG 範圍 → " + pct(vsUTG));
}
// 混合對手：一位範圍、一位任意牌，結果應介於「兩位任意」與「兩位 UTG」之間
{
  const both = equity("As Kh", "", [getPresetRange("UTG_OPEN"), null], N);
  assert(both > 0 && both < 1, "混合對手模擬應正常執行");
}

console.log("== 下注建議 ==");
{
  const a = adviseBet({ equity: 0.20, potSize: 100, toCall: 50, position: "BTN", numActiveOpp: 1, street: "flop" });
  assert(a.action === "fold", "勝率 20% 面對半池下注（需 33.3%）應棄牌，實際 " + a.action);
  const b = adviseBet({ equity: 0.45, potSize: 100, toCall: 25, position: "BB", numActiveOpp: 1, street: "flop" });
  assert(b.action === "call", "勝率 45% 面對 1/4 池下注（需 20%）應跟注，實際 " + b.action);
  const c = adviseBet({ equity: 0.85, potSize: 100, toCall: 50, position: "BTN", numActiveOpp: 1, street: "turn" });
  assert(c.action === "raise", "勝率 85% 面對下注應加注，實際 " + c.action);
  const d = adviseBet({ equity: 0.30, potSize: 0, toCall: 0, position: "SB", numActiveOpp: 1, street: "flop" });
  assert(d.action === "check", "免費看牌時弱牌應過牌而非棄牌，實際 " + d.action);
  const e = adviseBet({ equity: 0.90, potSize: 100, toCall: 0, position: "UTG", numActiveOpp: 2, street: "river" });
  assert(e.action === "bet" && e.sizePct >= 60, "勝率 90% 無人下注應下大注，實際 " + e.action + " " + e.sizePct);
  // 多人底池門檻上調：同樣 52% 勝率，單挑有位置可小注，四人底池應過牌
  const f = adviseBet({ equity: 0.52, potSize: 0, toCall: 0, position: "BTN", numActiveOpp: 1, street: "flop" });
  const g = adviseBet({ equity: 0.52, potSize: 0, toCall: 0, position: "BTN", numActiveOpp: 4, street: "flop" });
  assert(f.action === "bet" && f.sizePct === 33, "52% 單挑有位置應小注 1/3 池，實際 " + f.action);
  assert(g.action === "check", "52% 四人底池應過牌，實際 " + g.action);
}

console.log("");
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
