"use strict";
// UI 狀態與互動：牌槽、選牌器、對手人數、結果顯示

(function () {
  const ITERATIONS = 100000;
  const SLOT_LABELS = ["手牌", "手牌", "翻牌", "翻牌", "翻牌", "轉牌", "河牌"];

  const RANGE_OPTIONS = [
    ["RANDOM", "任意牌"],
    ["UTG_OPEN", "UTG 開牌（緊）"],
    ["MP_OPEN", "MP 開牌"],
    ["CO_OPEN", "CO 開牌"],
    ["BTN_OPEN", "BTN 開牌（寬）"],
    ["SB_OPEN", "SB 開牌"],
    ["BB_DEFEND", "BB 防守"]
  ];
  const MAX_OPP = 9;

  // slots[0..1] = 手牌，slots[2..6] = 公共牌
  const slots = [null, null, null, null, null, null, null];
  const opponents = [{ range: "RANDOM", folded: false }];
  let heroPos = "BTN";
  let selected = 0;      // 目前選取的牌槽
  let jobId = 0;         // 模擬任務編號（用來取消舊任務）
  let debounceTimer = null;
  let lastEquity = null; // 最近一次完成模擬的 equity（給下注建議用）

  const el = (id) => document.getElementById(id);
  const slotEls = [];
  const pickerBtns = new Array(52);

  // ---- Worker（失敗時退回主執行緒分批模擬） ----
  let worker = null;
  try {
    worker = new Worker("worker.js");
    worker.onmessage = (e) => handleResult(e.data);
    worker.onerror = () => { worker = null; };
  } catch (err) {
    worker = null;
  }

  function mainThreadSim(msg) {
    const oppRanges = msg.opponents.filter((o) => !o.folded).map((o) => getPresetRange(o.range));
    const sim = makeSim(msg.hero, msg.board, oppRanges);
    const counters = { win: 0, tie: 0, lose: 0, equity: 0, total: 0 };
    const handScore = msg.board.length >= 3
      ? evaluate(msg.hero.concat(msg.board), 2 + msg.board.length)
      : -1;
    function step() {
      if (msg.id !== jobId) return;
      const n = Math.min(5000, msg.iterations - counters.total);
      sim.run(n, counters);
      handleResult({
        id: msg.id,
        win: counters.win, tie: counters.tie, lose: counters.lose,
        equity: counters.equity, total: counters.total,
        handScore: handScore,
        done: counters.total >= msg.iterations
      });
      if (counters.total < msg.iterations) setTimeout(step, 0);
    }
    step();
  }

  // ---- 模擬控制 ----
  function scheduleRecalc() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(recalc, 120);
  }

  function activeOppCount() {
    return opponents.filter((o) => !o.folded).length;
  }

  function recalc() {
    jobId++;
    lastEquity = null;
    const hero = [slots[0], slots[1]];
    if (hero[0] === null || hero[1] === null) {
      showPlaceholder("請先選擇你的兩張手牌");
      return;
    }
    if (activeOppCount() === 0) {
      showPlaceholder("所有對手都已棄牌，你直接贏得底池");
      return;
    }
    const board = slots.slice(2).filter((c) => c !== null);
    el("results").classList.add("computing");
    el("status").textContent = "模擬中…";
    const msg = {
      id: jobId, hero, board,
      opponents: opponents.map((o) => ({ range: o.range, folded: o.folded })),
      iterations: ITERATIONS
    };
    if (worker) worker.postMessage(msg);
    else mainThreadSim(msg);
  }

  function handleResult(r) {
    if (r.id !== jobId) return;
    const t = r.total;
    el("winPct").textContent = (r.win / t * 100).toFixed(1) + "%";
    el("tiePct").textContent = (r.tie / t * 100).toFixed(1) + "%";
    el("losePct").textContent = (r.lose / t * 100).toFixed(1) + "%";
    el("equityPct").textContent = (r.equity / t * 100).toFixed(1) + "%";
    el("handName").textContent = r.handScore >= 0 ? "目前成牌：" + handName(r.handScore) : "";
    if (r.done) {
      el("results").classList.remove("computing");
      el("status").textContent = "已模擬 " + t.toLocaleString() + " 次（誤差約 ±0.3%）";
      lastEquity = r.equity / t;
      renderAdvice();
    } else {
      el("status").textContent = "模擬中… " + Math.round(t / ITERATIONS * 100) + "%";
    }
    el("results").classList.remove("empty");
  }

  function showPlaceholder(text) {
    el("results").classList.add("empty");
    el("results").classList.remove("computing");
    ["winPct", "tiePct", "losePct", "equityPct"].forEach((id) => { el(id).textContent = "–"; });
    el("handName").textContent = "";
    el("status").textContent = text;
    el("advice").hidden = true;
  }

  // ---- 下注建議 ----
  const ACTION_TEXT = { fold: "棄牌", check: "過牌", call: "跟注", bet: "下注", raise: "加注" };
  const STREETS = ["preflop", "preflop", "preflop", "flop", "turn", "river"];

  function renderAdvice() {
    const box = el("advice");
    if (lastEquity === null) { box.hidden = true; return; }
    const potSize = parseFloat(el("potSize").value) || 0;
    const toCall = parseFloat(el("toCall").value) || 0;
    const boardLen = slots.slice(2).filter((c) => c !== null).length;
    const a = adviseBet({
      equity: lastEquity,
      potSize: potSize,
      toCall: toCall,
      position: heroPos,
      numActiveOpp: activeOppCount(),
      street: STREETS[boardLen]
    });
    let text = "建議：" + ACTION_TEXT[a.action];
    if (a.sizePct) {
      text += " " + a.sizePct + "% 底池";
      if (potSize > 0) text += "（約 " + Math.round(potSize * a.sizePct / 100) + "）";
    }
    el("adviceAction").textContent = text;
    el("adviceReason").textContent = a.reason;
    box.hidden = false;
  }

  // ---- 牌槽與選牌器 ----
  function nextEmptySlot(from) {
    for (let i = 0; i < 7; i++) {
      const idx = (from + i) % 7;
      if (slots[idx] === null) return idx;
    }
    return -1;
  }

  function render() {
    const used = new Set(slots.filter((c) => c !== null));
    for (let i = 0; i < 7; i++) {
      const s = slotEls[i];
      const c = slots[i];
      s.classList.toggle("selected", i === selected);
      s.classList.toggle("filled", c !== null);
      if (c !== null) {
        s.querySelector(".slot-card").textContent = cardText(c);
        s.querySelector(".slot-card").className = "slot-card " + (((c / 13) | 0) === 1 || ((c / 13) | 0) === 2 ? "red" : "black");
      } else {
        s.querySelector(".slot-card").textContent = "";
        s.querySelector(".slot-card").className = "slot-card";
      }
    }
    for (let c = 0; c < 52; c++) {
      pickerBtns[c].disabled = used.has(c);
    }
  }

  // ---- 對手列表 ----
  function renderOpponents() {
    const wrap = el("oppList");
    wrap.textContent = "";
    opponents.forEach((opp, i) => {
      const row = document.createElement("div");
      row.className = "opp-row" + (opp.folded ? " folded" : "");

      const name = document.createElement("span");
      name.className = "opp-name";
      name.textContent = "對手 " + (i + 1);
      row.appendChild(name);

      const sel = document.createElement("select");
      for (const [value, label] of RANGE_OPTIONS) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = opp.range;
      sel.addEventListener("change", () => { opp.range = sel.value; scheduleRecalc(); });
      row.appendChild(sel);

      const foldBtn = document.createElement("button");
      foldBtn.type = "button";
      foldBtn.className = "opp-fold" + (opp.folded ? " active" : "");
      foldBtn.textContent = "棄";
      foldBtn.addEventListener("click", () => {
        opp.folded = !opp.folded;
        renderOpponents();
        scheduleRecalc();
      });
      row.appendChild(foldBtn);

      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "opp-remove";
      rmBtn.textContent = "×";
      rmBtn.addEventListener("click", () => {
        opponents.splice(i, 1);
        renderOpponents();
        scheduleRecalc();
      });
      row.appendChild(rmBtn);

      wrap.appendChild(row);
    });
    el("addOppBtn").disabled = opponents.length >= MAX_OPP;
  }

  function selectSlot(i) {
    if (slots[i] !== null) {
      slots[i] = null; // 點已填的牌槽 = 清除並選取它
      selected = i;
      render();
      scheduleRecalc();
    } else {
      selected = i;
      render();
    }
  }

  function pickCard(c) {
    if (slots.includes(c)) return;
    slots[selected] = c;
    const next = nextEmptySlot(selected + 1);
    if (next >= 0) selected = next;
    render();
    scheduleRecalc();
  }

  function reset() {
    for (let i = 0; i < 7; i++) slots[i] = null;
    selected = 0;
    jobId++;
    opponents.forEach((o) => { o.folded = false; });
    renderOpponents();
    render();
    showPlaceholder("請先選擇你的兩張手牌");
  }

  // ---- 建立 DOM ----
  function init() {
    // 對手列表
    el("addOppBtn").addEventListener("click", () => {
      if (opponents.length >= MAX_OPP) return;
      opponents.push({ range: "RANDOM", folded: false });
      renderOpponents();
      scheduleRecalc();
    });
    renderOpponents();

    // 我的位置與底池（底池/跟注額只影響建議，不用重跑模擬）
    const posSel = el("heroPos");
    for (const p of POSITIONS) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      posSel.appendChild(o);
    }
    posSel.value = heroPos;
    posSel.addEventListener("change", () => { heroPos = posSel.value; renderAdvice(); });
    el("potSize").addEventListener("input", renderAdvice);
    el("toCall").addEventListener("input", renderAdvice);

    // 牌槽
    const heroWrap = el("heroSlots");
    const boardWrap = el("boardSlots");
    for (let i = 0; i < 7; i++) {
      const d = document.createElement("div");
      d.className = "slot";
      d.innerHTML = '<span class="slot-card"></span><span class="slot-label">' + SLOT_LABELS[i] + "</span>";
      d.addEventListener("click", () => selectSlot(i));
      (i < 2 ? heroWrap : boardWrap).appendChild(d);
      slotEls.push(d);
    }

    // 選牌器：4 花色 × 13 rank
    const picker = el("picker");
    for (let s = 0; s < 4; s++) {
      const row = document.createElement("div");
      row.className = "picker-row";
      const label = document.createElement("span");
      label.className = "suit-label " + (s === 1 || s === 2 ? "red" : "black");
      label.textContent = SUIT_CHARS[s];
      row.appendChild(label);
      for (let r = 12; r >= 0; r--) {
        const c = s * 13 + r;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pick " + (s === 1 || s === 2 ? "red" : "black");
        b.textContent = RANK_CHARS[r];
        b.addEventListener("click", () => pickCard(c));
        pickerBtns[c] = b;
        row.appendChild(b);
      }
      picker.appendChild(row);
    }

    el("resetBtn").addEventListener("click", reset);

    render();
    showPlaceholder("請先選擇你的兩張手牌");

    // PWA：只在 http(s) 環境註冊 service worker
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
