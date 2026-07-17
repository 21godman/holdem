"use strict";
// 練習模式 UI：出題流程、作答、回饋、成績列、弱點面板、localStorage 持久化。
// 與 app.js 完全獨立：自己持有一個 Worker 實例與 jobId 計數，兩個模式不會互相干擾。

(function () {
  const SIM_ITERATIONS = 50000; // ±0.45%，遠小於選項間距 8 個百分點
  const STORAGE_KEY = "holdemQuizV1";
  const CURATED_PROB = 0.25;    // 每題抽到未看過精選題的機率
  const RECENT_MAX = 10;        // 最近題目去重視窗

  const GTO_ACTION_TEXT = { raise: "加注", "3bet": "3-bet", call: "跟注", fold: "棄牌" };

  const el = (id) => document.getElementById(id);

  let stats = loadStats();
  let current = null;    // 目前題目物件（quiz.js 形狀）
  let answered = false;
  let jobId = 0;
  const recentKeys = [];

  // ---- Worker（失敗時退回主執行緒分批模擬，同 app.js 策略）----
  let worker = null;
  try {
    worker = new Worker("worker.js");
    worker.onmessage = (e) => handleSimResult(e.data);
    worker.onerror = () => { worker = null; };
  } catch (err) {
    worker = null;
  }

  function runSim(hero, board, oppCount) {
    jobId++;
    const msg = {
      id: jobId, hero: hero, board: board,
      opponents: [], iterations: SIM_ITERATIONS
    };
    for (let i = 0; i < oppCount; i++) msg.opponents.push({ range: "RANDOM", folded: false });
    if (worker) { worker.postMessage(msg); return; }
    // 主執行緒退路：對手全為任意牌
    const sim = makeSim(hero, board, oppCount);
    const counters = { win: 0, tie: 0, lose: 0, equity: 0, total: 0 };
    (function step() {
      if (msg.id !== jobId) return;
      sim.run(Math.min(5000, msg.iterations - counters.total), counters);
      if (counters.total < msg.iterations) { setTimeout(step, 0); return; }
      handleSimResult({ id: msg.id, equity: counters.equity, total: counters.total, done: true });
    })();
  }

  function handleSimResult(r) {
    if (r.id !== jobId || !r.done) return;
    if (!current || current.type !== "equity") return;
    current.equity = r.equity / r.total;
    current.options = buildEquityOptions(current.equity);
    renderEquityChoices();
  }

  // ---- localStorage ----
  function loadStats() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (parsed && parsed.v === 1) return parsed;
    } catch (err) { /* 私密模式或資料損毀 → 重建 */ }
    return quizStatsInit();
  }

  function saveStats() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)); } catch (err) { /* 同上 */ }
  }

  // ---- 出題 ----
  function questionKey(q) {
    return q.type === "preflop"
      ? q.chartKey + ":" + q.handClass
      : q.hero.join(",") + "|" + q.board.join(",");
  }

  function nextQuestion() {
    const unseen = QUIZ_BANK.filter((e) => stats.seenCurated.indexOf(e.id) < 0);
    let q = null;
    if (unseen.length > 0 && Math.random() < CURATED_PROB) {
      q = curatedToQuestion(unseen[(Math.random() * unseen.length) | 0]);
    } else {
      for (let tries = 0; tries < 10; tries++) {
        q = Math.random() < 0.5 ? generatePreflopQuestion() : generateEquityScenario();
        if (recentKeys.indexOf(questionKey(q)) < 0) break;
      }
    }
    recentKeys.push(questionKey(q));
    if (recentKeys.length > RECENT_MAX) recentKeys.shift();
    current = q;
    answered = false;
    renderQuestion();
    if (q.type === "equity") runSim(q.hero, q.board, q.oppCount);
  }

  // ---- 渲染 ----
  function renderCards(wrap, cards) {
    wrap.textContent = "";
    for (const c of cards) {
      const d = document.createElement("div");
      const suit = (c / 13) | 0;
      d.className = "quiz-card " + (suit === 1 || suit === 2 ? "red" : "black");
      d.textContent = cardText(c);
      wrap.appendChild(d);
    }
  }

  function renderQuestion() {
    const q = current;
    el("quizTag").textContent = q.curatedId
      ? "精選・" + q.concept
      : (q.type === "preflop" ? "翻前決策" : "勝率估算");
    el("quizFeedback").hidden = true;
    el("quizNextBtn").hidden = true;
    el("quizVerdict").className = "";

    if (q.type === "preflop") {
      const openBB = q.openerPos ? GTO_SIZING.rfiBB[q.openerPos] : null;
      el("quizPrompt").textContent = q.openerPos
        ? "你在 " + q.heroPos + "，" + q.openerPos + " 開池加注 " + openBB + "bb，其他人棄牌輪到你。該怎麼做？"
        : "你在 " + q.heroPos + "，前面所有人棄牌輪到你。該怎麼做？";
      renderCards(el("quizHand"), q.cards);
      el("quizBoardGroup").hidden = true;
      renderPreflopChoices();
    } else {
      el("quizPrompt").textContent = "你的手牌對上 " + q.oppCount + " 位任意範圍對手"
        + (q.board.length ? "，牌面如下" : "（翻牌前）") + "。你目前的勝率（權益）最接近多少？";
      renderCards(el("quizHand"), q.hero);
      el("quizBoardGroup").hidden = q.board.length === 0;
      if (q.board.length) renderCards(el("quizBoard"), q.board);
      const wrap = el("quizChoices");
      wrap.textContent = "";
      const note = document.createElement("div");
      note.id = "quizComputing";
      note.textContent = "模擬計算中…先估估看再作答";
      wrap.appendChild(note);
    }
  }

  function choiceButton(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "quiz-choice";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderPreflopChoices() {
    const q = current;
    const wrap = el("quizChoices");
    wrap.textContent = "";
    const LABELS = q.openerPos
      ? { "3bet": "3-bet", call: "跟注", fold: "棄牌" }
      : { raise: "加注開池", call: "跟注（平跟）", fold: "棄牌" };
    for (const action of q.actions) {
      wrap.appendChild(choiceButton(LABELS[action], (ev) => onPreflopChoose(action, ev.target)));
    }
  }

  function renderEquityChoices() {
    const q = current;
    const wrap = el("quizChoices");
    wrap.textContent = "";
    for (const v of q.options) {
      wrap.appendChild(choiceButton(v + "%", (ev) => onEquityChoose(v, ev.target)));
    }
  }

  // ---- 作答 ----
  function lockChoices(chosenBtn) {
    const btns = el("quizChoices").querySelectorAll(".quiz-choice");
    btns.forEach((b) => { b.disabled = true; });
    chosenBtn.classList.add("chosen");
    return btns;
  }

  function onPreflopChoose(action, btn) {
    if (answered) return;
    answered = true;
    const q = current;
    const result = gradePreflop(q.strat, action);
    const btns = lockChoices(btn);
    // 標示正解：頻率 ≥50 的行動亮金、所選錯誤行動標紅
    const LABELS = q.openerPos
      ? { "3bet": "3-bet", call: "跟注", fold: "棄牌" }
      : { raise: "加注開池", call: "跟注（平跟）", fold: "棄牌" };
    const goodActions = q.strat.filter((a) => a.freq >= 50).map((a) => a.action);
    btns.forEach((b) => {
      const a = q.actions[Array.prototype.indexOf.call(btns, b)];
      if (goodActions.indexOf(a) >= 0) b.classList.add("hit");
      else if (b === btn && result === "wrong") b.classList.add("miss");
    });
    finishAnswer(result, {
      type: "preflop",
      chartId: q.chartType + ":" + q.chartKey,
      key: q.handClass,
      curatedId: q.curatedId || null,
      ts: Date.now()
    }, preflopExplainHtml(q, action, LABELS));
  }

  function onEquityChoose(value, btn) {
    if (answered) return;
    answered = true;
    const q = current;
    const result = gradeEquity(q.options, value, q.equity);
    const btns = lockChoices(btn);
    const target = q.equity * 100;
    let best = q.options[0];
    for (const o of q.options) if (Math.abs(o - target) < Math.abs(best - target)) best = o;
    btns.forEach((b) => {
      const v = parseInt(b.textContent, 10);
      if (v === best) b.classList.add("hit");
      else if (b === btn && result === "wrong") b.classList.add("miss");
    });
    finishAnswer(result, {
      type: "equity",
      key: q.hero.map(cardText).join(""),
      curatedId: q.curatedId || null,
      ts: Date.now()
    }, equityExplainHtml(q));
  }

  const VERDICT_TEXT = { correct: "✓ 正確", partial: "△ 部分正確（低頻行動）", wrong: "✗ 錯誤" };

  function finishAnswer(result, meta, explainHtml) {
    stats = quizStatsUpdate(stats, meta, result);
    saveStats();
    el("quizVerdict").textContent = VERDICT_TEXT[result];
    el("quizVerdict").className = result;
    el("quizExplain").innerHTML = explainHtml;
    el("quizFeedback").hidden = false;
    el("quizNextBtn").hidden = false;
    renderStatsBar();
    renderWeakSpots();
  }

  // ---- 解說文字 ----
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function preflopExplainHtml(q, chosen, labels) {
    const freqs = q.strat
      .filter((a) => a.freq > 0)
      .map((a) => GTO_ACTION_TEXT[a.action] + " " + a.freq + "%")
      .join("／");
    const chartLabel = quizChartLabel(q.chartType + ":" + q.chartKey);
    let html = "";
    if (q.explain) html += esc(q.explain);
    html += '<span class="quiz-freq">' + esc(q.handClass) + " 的 GTO 策略：" + esc(freqs)
      + "・圖表：" + esc(chartLabel) + "（100bb 6-max 近似解）</span>";
    return html;
  }

  function equityExplainHtml(q) {
    const pct = (q.equity * 100).toFixed(1) + "%";
    let html = "";
    if (q.explain) html += esc(q.explain);
    html += '<span class="quiz-freq">模擬 ' + SIM_ITERATIONS.toLocaleString()
      + " 次的實際勝率：" + esc(pct) + "</span>";
    return html;
  }

  // ---- 成績列與弱點 ----
  function renderStatsBar() {
    el("qsTotal").textContent = stats.total;
    el("qsAcc").textContent = stats.total
      ? Math.round((stats.correct + 0.5 * stats.partial) / stats.total * 100) + "%"
      : "–";
    el("qsStreak").textContent = stats.streak;
    el("qsBest").textContent = stats.bestStreak;
  }

  function renderWeakSpots() {
    const spots = quizWeakSpots(stats);
    el("quizWeakPanel").hidden = spots.length === 0;
    const wrap = el("quizWeak");
    wrap.textContent = "";
    for (const s of spots) {
      const row = document.createElement("div");
      row.className = "quiz-weak-row";
      const name = document.createElement("span");
      name.textContent = s.label;
      const acc = document.createElement("span");
      acc.className = "acc";
      acc.textContent = Math.round(s.acc * 100) + "%（" + s.total + " 題）";
      row.appendChild(name);
      row.appendChild(acc);
      wrap.appendChild(row);
    }
  }

  // ---- 模式切換 ----
  function setMode(quiz) {
    document.body.classList.toggle("quiz", quiz);
    el("calcView").hidden = quiz;
    el("quizView").hidden = !quiz;
    el("modeBtn").textContent = quiz ? "計算模式" : "練習模式";
    if (quiz && !current) nextQuestion();
  }

  function init() {
    el("modeBtn").addEventListener("click", () => setMode(el("quizView").hidden));
    el("quizNextBtn").addEventListener("click", nextQuestion);
    renderStatsBar();
    renderWeakSpots();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
