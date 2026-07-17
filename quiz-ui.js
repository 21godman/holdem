"use strict";
// 練習模式 UI：關卡地圖 → 答題 → 結算 三個子視圖的狀態機，外加自由練習（無限出題）。
// 與 app.js 完全獨立：自己持有一個 Worker 實例與 jobId 計數，兩個模式不會互相干擾。

(function () {
  const SIM_ITERATIONS = 50000; // ±0.45%，遠小於選項最小間距 8 個百分點
  const STORAGE_KEY = "holdemQuizV1";
  const CURATED_PROB = 0.25;    // 自由練習抽到未看過精選題的機率
  const RECENT_MAX = 10;        // 自由練習最近題目去重視窗

  const GTO_ACTION_TEXT = { raise: "加注", "3bet": "3-bet", call: "跟注", fold: "棄牌" };

  const el = (id) => document.getElementById(id);

  let stats = loadStats();
  let view = "home";        // "home" | "play" | "result"
  let playMode = "free";    // "level" | "free"
  let level = null;         // 目前關卡（QUIZ_LEVELS 條目）
  let session = null;       // 關卡進行中：{n, score, review: [], keys: []}
  let current = null;       // 目前題目物件（quiz.js 形狀）
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
    current.options = buildEquityOptions(current.equity, undefined, current.spacing);
    renderEquityChoices();
  }

  // ---- localStorage ----
  function loadStats() {
    try {
      const migrated = quizStatsMigrate(JSON.parse(localStorage.getItem(STORAGE_KEY)));
      if (migrated) return migrated;
    } catch (err) { /* 私密模式或資料損毀 → 重建 */ }
    return quizStatsInit();
  }

  function saveStats() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)); } catch (err) { /* 同上 */ }
  }

  // ---- 視圖切換 ----
  function setView(v) {
    view = v;
    el("quizHome").hidden = v !== "home";
    el("quizPlay").hidden = v !== "play";
    el("quizResultView").hidden = v !== "result";
    if (v === "home") renderHome();
  }

  // ---- 關卡地圖 ----
  function starText(n) {
    let s = "";
    for (let i = 0; i < 3; i++) s += i < n ? "★" : "☆";
    return s;
  }

  function renderHome() {
    const wrap = el("quizLevels");
    wrap.textContent = "";
    const c = stats.campaign;
    for (const lv of QUIZ_LEVELS) {
      const row = document.createElement("button");
      row.type = "button";
      const cleared = (c.stars[lv.id] || 0) > 0;
      const locked = lv.id > c.unlocked;
      row.className = "quiz-level-row"
        + (cleared ? " cleared" : "")
        + (!cleared && lv.id === c.unlocked ? " next" : "")
        + (locked ? " locked" : "");
      row.disabled = locked;

      const no = document.createElement("span");
      no.className = "lv-no";
      no.textContent = locked ? "🔒" : "第" + lv.id + "關";
      row.appendChild(no);

      const mid = document.createElement("span");
      const title = document.createElement("div");
      title.className = "lv-title";
      title.textContent = lv.title + "｜" + lv.tag;
      const tag = document.createElement("div");
      tag.className = "lv-tag";
      tag.textContent = locked ? "通過上一關解鎖" : lv.desc;
      mid.appendChild(title);
      mid.appendChild(tag);
      row.appendChild(mid);

      const st = document.createElement("span");
      st.className = "lv-stars";
      st.textContent = locked ? "" : starText(c.stars[lv.id] || 0);
      row.appendChild(st);

      if (!locked) row.addEventListener("click", () => startLevel(lv));
      wrap.appendChild(row);
    }
    renderStatsBar();
    renderWeakSpots();
  }

  // ---- 出題流程 ----
  function questionKey(q) {
    return q.type === "preflop"
      ? q.chartKey + ":" + q.handClass
      : q.hero.join(",") + "|" + q.board.join(",");
  }

  function startLevel(lv) {
    level = lv;
    playMode = "level";
    session = { n: 0, score: 0, review: [], keys: [] };
    setView("play");
    nextQuestion();
  }

  function startFree() {
    playMode = "free";
    level = null;
    session = null;
    setView("play");
    nextQuestion();
  }

  function nextQuestion() {
    if (playMode === "level" && session.n >= level.count) { showResult(); return; }
    let q = null;
    if (playMode === "level") {
      for (let tries = 0; tries < 10; tries++) {
        q = generateLevelQuestion(level);
        if (session.keys.indexOf(questionKey(q)) < 0) break;
      }
      session.keys.push(questionKey(q));
    } else {
      const unseen = QUIZ_BANK.filter((e) => stats.seenCurated.indexOf(e.id) < 0);
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
    }
    current = q;
    answered = false;
    renderPlayHeader();
    renderQuestion();
    if (q.type === "equity") runSim(q.hero, q.board, q.oppCount);
  }

  function renderPlayHeader() {
    const info = el("quizPlayInfo");
    if (playMode === "level") {
      info.innerHTML = "第" + level.id + "關・" + esc(level.title)
        + '　<span class="lv-progress">' + (session.n + 1) + "/" + level.count
        + "　得分 " + session.score + "</span>";
    } else {
      info.textContent = "自由練習・連對 " + stats.streak;
    }
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

  function preflopLabels(q) {
    return q.openerPos
      ? { "3bet": "3-bet", call: "跟注", fold: "棄牌" }
      : { raise: "加注開池", call: "跟注（平跟）", fold: "棄牌" };
  }

  function renderPreflopChoices() {
    const q = current;
    const wrap = el("quizChoices");
    wrap.textContent = "";
    const LABELS = preflopLabels(q);
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
    const LABELS = preflopLabels(q);
    const goodActions = q.strat.filter((a) => a.freq >= 50).map((a) => a.action);
    btns.forEach((b) => {
      const a = q.actions[Array.prototype.indexOf.call(btns, b)];
      if (goodActions.indexOf(a) >= 0) b.classList.add("hit");
      else if (b === btn && result === "wrong") b.classList.add("miss");
    });
    if (playMode === "level" && result !== "correct") {
      const freqs = q.strat.filter((a) => a.freq > 0)
        .map((a) => GTO_ACTION_TEXT[a.action] + " " + a.freq + "%").join("／");
      session.review.push({
        hand: q.handClass,
        detail: quizChartLabel(q.chartType + ":" + q.chartKey)
          + "　你選 " + LABELS[action] + " → 正解 " + freqs
      });
    }
    finishAnswer(result, {
      type: "preflop",
      chartId: q.chartType + ":" + q.chartKey,
      key: q.handClass,
      curatedId: q.curatedId || null,
      ts: Date.now()
    }, preflopExplainHtml(q));
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
    if (playMode === "level" && result !== "correct") {
      session.review.push({
        hand: q.hero.map(cardText).join(" "),
        detail: "對 " + q.oppCount + " 位對手　你選 " + value + "% → 實際 " + (q.equity * 100).toFixed(1) + "%"
      });
    }
    finishAnswer(result, {
      type: "equity",
      key: q.hero.map(cardText).join(""),
      curatedId: q.curatedId || null,
      ts: Date.now()
    }, equityExplainHtml(q));
  }

  const VERDICT_TEXT = { correct: "✓ 正確", partial: "△ 部分正確（低頻行動）", wrong: "✗ 錯誤" };
  const RESULT_SCORE = { correct: 1, partial: 0.5, wrong: 0 };

  function finishAnswer(result, meta, explainHtml) {
    stats = quizStatsUpdate(stats, meta, result);
    saveStats();
    if (playMode === "level") {
      session.score += RESULT_SCORE[result];
      session.n++;
      renderPlayHeader();
      el("quizNextBtn").textContent = session.n >= level.count ? "看結算 →" : "下一題 →";
    } else {
      renderPlayHeader();
      el("quizNextBtn").textContent = "下一題 →";
    }
    el("quizVerdict").textContent = VERDICT_TEXT[result];
    el("quizVerdict").className = result;
    el("quizExplain").innerHTML = explainHtml;
    el("quizFeedback").hidden = false;
    el("quizNextBtn").hidden = false;
  }

  // ---- 關卡結算 ----
  function showResult() {
    stats = quizCampaignUpdate(stats, level.id, session.score);
    saveStats();
    const score = session.score;
    const stars = quizLevelStars(score);
    el("quizResultTitle").textContent = "第" + level.id + "關・" + level.title + " 完成！";
    const starEl = el("quizStars");
    starEl.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const s = document.createElement("span");
      if (i >= stars) s.className = "off";
      s.textContent = "★";
      starEl.appendChild(s);
    }
    const scoreEl = el("quizScore");
    scoreEl.textContent = score + " / " + level.count;
    scoreEl.className = stars > 0 ? "pass" : "fail";
    el("quizStarHint").textContent =
      stars === 0 ? "差 " + (7 - score) + " 分過關，再試一次！"
      : stars === 1 ? "再拿 " + (8.5 - score) + " 分即可兩星"
      : stars === 2 ? "滿分才有三星，差 " + (10 - score) + " 分"
      : "完美！全對三星";

    const review = el("quizReview");
    review.textContent = "";
    if (session.review.length) {
      const h = document.createElement("h2");
      h.textContent = "錯題回顧";
      review.appendChild(h);
      for (const r of session.review) {
        const row = document.createElement("div");
        row.className = "quiz-review-row";
        const hand = document.createElement("span");
        hand.className = "rv-hand";
        hand.textContent = r.hand + "　";
        const det = document.createElement("span");
        det.className = "rv-detail";
        det.textContent = r.detail;
        row.appendChild(hand);
        row.appendChild(det);
        review.appendChild(row);
      }
    }
    const next = QUIZ_LEVELS[level.id]; // id 是 1-based，下一關即索引 [id]
    el("quizNextLevelBtn").hidden = !(next && stats.campaign.unlocked >= next.id);
    setView("result");
  }

  // ---- 解說文字 ----
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function preflopExplainHtml(q) {
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

  // ---- 成績列與弱點（關卡地圖用）----
  function renderStatsBar() {
    el("qsTotal").textContent = stats.total;
    el("qsAcc").textContent = stats.total
      ? Math.round((stats.correct + 0.5 * stats.partial) / stats.total * 100) + "%"
      : "–";
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

  // ---- 模式切換與初始化 ----
  function setMode(quiz) {
    document.body.classList.toggle("quiz", quiz);
    el("calcView").hidden = quiz;
    el("quizView").hidden = !quiz;
    el("modeBtn").textContent = quiz ? "計算模式" : "練習模式";
    if (quiz && view === "home") renderHome();
  }

  function resetAll() {
    if (!window.confirm("確定要清空所有練習紀錄嗎？關卡進度、星星與統計都會歸零。")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* 忽略 */ }
    stats = quizStatsInit();
    jobId++; // 取消進行中的模擬
    current = null;
    session = null;
    setView("home");
  }

  function init() {
    el("modeBtn").addEventListener("click", () => setMode(el("quizView").hidden));
    el("quizNextBtn").addEventListener("click", nextQuestion);
    el("quizFreeBtn").addEventListener("click", startFree);
    el("quizExitBtn").addEventListener("click", () => { jobId++; current = null; setView("home"); });
    el("quizRetryBtn").addEventListener("click", () => startLevel(level));
    el("quizNextLevelBtn").addEventListener("click", () => startLevel(QUIZ_LEVELS[level.id]));
    el("quizMapBtn").addEventListener("click", () => setView("home"));
    el("quizResetBtn").addEventListener("click", resetAll);
    setView("home");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
