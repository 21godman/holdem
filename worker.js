"use strict";
// 背景模擬 Worker：分批執行蒙地卡羅，批次之間讓出事件迴圈以便接收取消（新任務）訊息
importScripts("poker.js");

const BATCH = 10000;
let currentId = 0;

onmessage = function (e) {
  const msg = e.data;
  currentId = msg.id;
  // opponents: [{range, folded}]；棄牌者不進模擬。舊協定 numOpp（數字）仍相容。
  const oppRanges = msg.opponents
    ? msg.opponents.filter((o) => !o.folded).map((o) => getPresetRange(o.range))
    : msg.numOpp;
  const sim = makeSim(msg.hero, msg.board, oppRanges);
  const counters = { win: 0, tie: 0, lose: 0, equity: 0, total: 0 };
  const handScore = msg.board.length >= 3
    ? evaluate(msg.hero.concat(msg.board), 2 + msg.board.length)
    : -1;

  function step() {
    if (msg.id !== currentId) return; // 已被新任務取代
    const n = Math.min(BATCH, msg.iterations - counters.total);
    sim.run(n, counters);
    postMessage({
      id: msg.id,
      win: counters.win, tie: counters.tie, lose: counters.lose,
      equity: counters.equity, total: counters.total,
      handScore: handScore,
      done: counters.total >= msg.iterations
    });
    if (counters.total < msg.iterations) setTimeout(step, 0);
  }
  step();
};
