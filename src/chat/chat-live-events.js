import { getSetting } from "../settings.js";
// Live Twitch predictions & polls atop chat, with betting and voting (unofficial GQL via the device login,
// same as pins / channel points). Mixed into TwitchChat (see chat.js).
//
// - data: get_channel_prediction / get_channel_poll (Rust, helix.rs), polled every 5s for the watched channel
// - actions: make_prediction (bet channel points), vote_on_poll
// - rendering: cards are REBUILT only when their structure changes (new event, status, outcome count, your
//   bet); every other refresh updates numbers in place, so a half-typed bet amount is never wiped and the
//   card never flickers

import { invoke } from "@tauri-apps/api/core";

const POLL_MS = 5000;
const MAX_BET = 250000; // Twitch's per-prediction cap
const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
};
const fmtFull = (n) => (Number(n) || 0).toLocaleString();
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const ICONS = {
  prediction: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/></svg>',
  poll: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 20V10"/><path d="M12 20V4"/><path d="M19 20v-7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
const RING_C = 2 * Math.PI * 7;

function predEnded(p) { return p.status === "RESOLVED" || p.status === "CANCELED" || p.status === "RESOLVE_PENDING" || p.status === "CANCEL_PENDING"; }
function pollEnded(p) { return p.status && p.status !== "ACTIVE"; }

export const chatLiveEventsMixin = {
  _leState() {
    if (!this._le) {
      this._le = {
        login: null, pred: null, poll: null, balance: null,
        ended: null,      // a prediction that just left the running/locked lists: kept on screen with its result
        pollEnded: null,  // a poll that just ended: final results kept on screen for a while
        myBets: new Map(), myVotes: new Map(), collapsed: new Set(), dismissed: new Set(),
        sel: null, amount: "", busy: false, error: "", keys: {},
      };
    }
    return this._le;
  },

  // ---- lifecycle (names kept: called from chat.js on join / leave) ----
  _startPredictionPoll(login) {
    this._stopPredictionPoll();
    if (!login) return;
    const s = this._leState();
    s.login = login;
    const tick = async () => {
      if (s.login !== login) return;
      await Promise.all([this._leFetchPred(login), this._leFetchPoll(login)]);
    };
    tick();
    s.pollTimer = setInterval(tick, POLL_MS);
    s.tickTimer = setInterval(() => this._leTick(), 1000);
  },

  _stopPredictionPoll() {
    const s = this._leState();
    clearInterval(s.pollTimer); clearInterval(s.tickTimer);
    s.pollTimer = s.tickTimer = null;
    s.login = null; s.pred = null; s.poll = null; s.balance = null; s.sel = null; s.amount = ""; s.error = "";
    s.ended = null; s.pollEnded = null;
    this._leRender("pred"); this._leRender("poll");
  },

  async _leFetchPred(login) {
    const s = this._leState();
    try {
      const p = await invoke("get_channel_prediction", { channelLogin: login });
      if (s.login !== login) return;
      const prev = s.pred;
      const next = p && p.id ? p : null;
      // Twitch drops a prediction from its running/locked lists once it's resolved or canceled. keep the card
      // and work out the result, instead of it silently vanishing
      if (prev && (!next || next.id !== prev.id) && !predEnded(prev)) this._leBeginEnded(prev, login);
      s.pred = next;
      if (next && next.id !== (prev && prev.id)) {
        s.sel = null; s.amount = ""; s.error = "";
        if (s.ended && s.ended.event.id !== next.id) s.ended = null; // a new prediction replaces the old result
      }
      if (s.pred && !predEnded(s.pred)) {
        const bal = await invoke("get_channel_points", { channelLogin: login }).catch(() => null);
        if (s.login === login) s.balance = bal;
      }
    } catch (err) {
      console.warn("[predictions]", err);
    }
    this._leRender("pred");
  },

  async _leFetchPoll(login) {
    const s = this._leState();
    try {
      const p = await invoke("get_channel_poll", { channelLogin: login });
      if (s.login !== login) return;
      const prev = s.poll;
      s.poll = p && p.id ? { ...p, _fetchedAt: Date.now() } : null;
      // ended or gone: keep the final results up for a while and say who won
      if (prev && !pollEnded(prev) && (!s.poll || s.poll.id !== prev.id || pollEnded(s.poll))) {
        this._leEndPoll(s.poll && s.poll.id === prev.id ? s.poll : prev);
      }
    } catch (err) {
      console.warn("[polls]", err);
    }
    this._leRender("poll");
  },

  // ---- results ----
  // a prediction left the running/locked lists: show "Ended, waiting for the result", then resolve it from
  // Twitch (get_prediction_result), falling back to your channel-points balance if Twitch won't say
  _leBeginEnded(prev, login) {
    const s = this._leState();
    s.ended = {
      event: { ...prev, status: "RESOLVE_PENDING" },
      bet: s.myBets.get(prev.id) || null,
      base: s.balance,           // balance while locked (after your bet was taken)
      since: Date.now(), result: null, login,
    };
    this._leRender("pred");
    this._leResolveLoop(s.ended);
  },

  async _leResolveLoop(e) {
    const s = this._leState();
    while (s.ended === e && !e.result) {
      const elapsed = Date.now() - e.since;
      let r = null;
      // once Twitch has rejected the lookup it won't start accepting it mid-prediction: stop asking (each try
      // walks every candidate query) and rely on the balance fallback
      if (!e.noLookup) {
        try {
          r = await invoke("get_prediction_result", { channelLogin: e.login, eventId: e.event.id });
        } catch (err) {
          console.warn("[predictions] result lookup:", err);
          if (String(err).includes("no prediction-result field")) e.noLookup = true;
        }
      }
      if (s.ended !== e) return;
      if (r && r.id && (r.status === "RESOLVED" || r.status === "CANCELED")) { this._leApplyResult(e, r, false); return; }
      // balance fallback (only tells us something if you bet): your payout lands on your balance
      if (e.bet && e.base != null) {
        const bal = await invoke("get_channel_points", { channelLogin: e.login }).catch(() => null);
        if (s.ended !== e) return;
        if (bal != null) {
          const delta = bal - e.base;
          const o = e.event.outcomes.find((x) => x.id === e.bet.outcomeId);
          const total = e.event.outcomes.reduce((a, x) => a + (x.total_points || 0), 0);
          const payout = o && o.total_points > 0 ? Math.floor(e.bet.points * total / o.total_points) : e.bet.points;
          const near = (a, b) => Math.abs(a - b) <= Math.max(60, b * 0.1);
          if (delta >= payout * 0.9 && !(near(delta, e.bet.points) && payout > e.bet.points * 1.2)) {
            this._leApplyResult(e, { ...e.event, status: "RESOLVED", winning_outcome_id: e.bet.outcomeId, _payout: delta }, true); return;
          }
          if (near(delta, e.bet.points)) { this._leApplyResult(e, { ...e.event, status: "CANCELED" }, true); return; }
          if (elapsed > 45000 && delta < e.bet.points * 0.5) {
            const others = e.event.outcomes.filter((x) => x.id !== e.bet.outcomeId);
            this._leApplyResult(e, { ...e.event, status: "RESOLVED", winning_outcome_id: others.length === 1 ? others[0].id : null }, true); return;
          }
        }
      }
      if (elapsed > 120000) { this._leApplyResult(e, { ...e.event, status: "RESOLVED", winning_outcome_id: null }, true); return; }
      await new Promise((res) => setTimeout(res, 4000));
    }
  },

  // final state -> result for you (won / lost / refunded / just ended), shown on the card and once in chat
  _leApplyResult(e, r, inferred) {
    const s = this._leState();
    const outcomes = r.outcomes && r.outcomes.length ? r.outcomes : e.event.outcomes;
    e.event = { ...e.event, ...r, outcomes };
    const winner = outcomes.find((o) => o.id === r.winning_outcome_id) || null;
    const total = outcomes.reduce((a, o) => a + (o.total_points || 0), 0);
    let kind = "ENDED", points = 0;
    if (r.status === "CANCELED") { kind = e.bet ? "REFUND" : "CANCELED"; points = e.bet ? e.bet.points : 0; }
    else if (e.bet && winner) {
      if (winner.id === e.bet.outcomeId) {
        kind = "WON";
        points = r._payout || (winner.total_points > 0 ? Math.floor(e.bet.points * total / winner.total_points) : e.bet.points);
      } else { kind = "LOST"; points = e.bet.points; }
    } else if (e.bet && !winner && inferred) { kind = "UNKNOWN"; }
    e.result = { kind, points, winner, inferred };
    e.expires = Date.now() + 120000; // the finished card clears itself after 2 minutes
    this._leRender("pred");
    const title = e.event.title ? `"${e.event.title}"` : "Prediction";
    const msg = kind === "WON" ? `You won ${points.toLocaleString()} channel points!`
      : kind === "LOST" ? `You lost ${points.toLocaleString()} channel points.`
      : kind === "REFUND" ? `It was canceled; your ${points.toLocaleString()} points were refunded.`
      : kind === "CANCELED" ? "It was canceled."
      : kind === "UNKNOWN" ? "Couldn't confirm whether you won."
      : "";
    this.systemLine?.(`Prediction ended: ${title}${winner ? ` · ${winner.title} won` : ""}. ${msg}`.trim());
  },

  _leEndPoll(poll) {
    const s = this._leState();
    const final = { ...poll, status: pollEnded(poll) ? poll.status : "COMPLETED" };
    s.pollEnded = { poll: final, until: Date.now() + 90000 };
    const total = final.choices.reduce((a, c) => a + (c.votes || 0), 0);
    const top = [...final.choices].sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
    if (top && total > 0) {
      this.systemLine?.(`Poll ended: "${final.title}" · ${top.title} won with ${Math.round((top.votes / total) * 100)}%.`);
    }
    this._leRender("poll");
  },

  // ---- current data ----
  _leData(kind) {
    const s = this._leState();
    if (kind === "pred") return s.pred || (s.ended && s.ended.event) || null;
    return s.poll || (s.pollEnded && Date.now() < s.pollEnded.until ? s.pollEnded.poll : null);
  },
  _leBalance() {
    const s = this._leState();
    return s.balance;
  },

  _predSecondsLeft(p) {
    const start = Date.parse(p.created_at || "");
    if (isNaN(start)) return 0;
    return Math.max(0, Math.round((start + (p.window_seconds || 0) * 1000 - Date.now()) / 1000));
  },
  _pollSecondsLeft(p) {
    if (p.remaining_ms > 0 && p._fetchedAt) return Math.max(0, Math.round((p.remaining_ms - (Date.now() - p._fetchedAt)) / 1000));
    const start = Date.parse(p.started_at || "");
    if (isNaN(start)) return 0;
    return Math.max(0, Math.round((start + (p.duration_seconds || 0) * 1000 - Date.now()) / 1000));
  },

  // countdown ring + mm:ss for a rendered card
  _leUpdateTimer(kind, slot, d) {
    const total = kind === "pred" ? d.window_seconds : d.duration_seconds;
    const left = kind === "pred" ? this._predSecondsLeft(d) : this._pollSecondsLeft(d);
    const ring = slot.querySelector(".le-ring-arc");
    const txt = slot.querySelector(".le-timer-text");
    if (ring && total > 0) ring.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, left / total)));
    if (txt) txt.textContent = mmss(left);
  },

  // every second: countdowns. a card is only re-rendered when what it SHOWS changes (e.g. the prediction
  // window ran out -> "Locked"), never unconditionally, so this can't loop
  _leTick() {
    const s = this._leState();
    if (s.ended && s.ended.expires && Date.now() >= s.ended.expires) { s.ended = null; this._leRender("pred"); }
    if (s.pollEnded && Date.now() >= s.pollEnded.until) { s.pollEnded = null; this._leRender("poll"); }
    for (const kind of ["pred", "poll"]) {
      const d = this._leData(kind);
      const slot = document.getElementById(kind === "pred" ? "prediction-overlay" : "poll-overlay");
      if (!slot) continue;
      if (!d) { if (slot.firstChild) this._leRender(kind); continue; }
      if (!slot.firstChild) continue;
      const key = kind === "pred" ? this._predKey(d) : this._pollKey(d);
      if (s.keys[kind] !== key) this._leRender(kind);
      else this._leUpdateTimer(kind, slot, d);
    }
  },

  // ---- rendering ----
  _leRender(kind) {
    const slot = document.getElementById(kind === "pred" ? "prediction-overlay" : "poll-overlay");
    if (!slot) return;
    const s = this._leState();
    const d = getSetting("predictionsPolls") ? this._leData(kind) : null; // Settings > Chat
    if (!d || s.dismissed.has(d.id)) {
      slot.style.display = "none";
      slot.replaceChildren();
      s.keys[kind] = null;
      return;
    }
    const key = kind === "pred" ? this._predKey(d) : this._pollKey(d);
    if (s.keys[kind] !== key || !slot.firstChild) {
      slot.replaceChildren(kind === "pred" ? this._buildPredCard(d) : this._buildPollCard(d));
      s.keys[kind] = key;
    }
    if (kind === "pred") this._updatePredCard(slot, d); else this._updatePollCard(slot, d);
    this._leUpdateTimer(kind, slot, d);
    slot.style.display = "block";
  },

  _predStatus(d) {
    if (d.status === "ACTIVE" && this._predSecondsLeft(d) === 0) return "LOCKED";
    return d.status;
  },
  _predKey(d) {
    const s = this._leState();
    const bet = s.myBets.get(d.id);
    const res = s.ended && s.ended.event.id === d.id && s.ended.result ? s.ended.result.kind : "";
    return [d.id, this._predStatus(d), d.outcomes.length, bet ? bet.outcomeId : "", s.collapsed.has(d.id), !!s.busy, res].join("|");
  },
  _pollKey(d) {
    const s = this._leState();
    return [d.id, pollEnded(d) ? "ENDED" : "ACTIVE", d.choices.length, s.myVotes.get(d.id) || "", s.collapsed.has(d.id)].join("|");
  },

  _cardShell(kind, d, statusNode, ended) {
    const s = this._leState();
    const card = el("div", `le-card le-${kind}` + (s.collapsed.has(d.id) ? " collapsed" : "") + (ended ? " ended" : ""));
    const head = el("div", "le-head");
    const badge = el("span", "le-kind");
    badge.innerHTML = kind === "pred" ? ICONS.prediction : ICONS.poll;
    badge.appendChild(el("span", null, kind === "pred" ? "Prediction" : "Poll"));
    const spacer = el("span", "le-head-spacer");
    const collapse = el("button", "le-icon-btn le-collapse");
    collapse.type = "button";
    collapse.title = s.collapsed.has(d.id) ? "Expand" : "Minimize";
    collapse.innerHTML = ICONS.chevron;
    collapse.addEventListener("click", () => {
      if (s.collapsed.has(d.id)) s.collapsed.delete(d.id); else s.collapsed.add(d.id);
      this._leRender(kind);
    });
    head.append(badge, spacer, statusNode, collapse);
    if (ended) {
      const x = el("button", "le-icon-btn le-dismiss");
      x.type = "button";
      x.title = "Dismiss";
      x.innerHTML = ICONS.close;
      x.addEventListener("click", () => {
        s.dismissed.add(d.id);
        this._leRender(kind);
      });
      head.appendChild(x);
    }
    // the question gets its own full-width line (it used to share the header row and got cut off)
    card.append(head, el("div", "le-title", d.title || ""));
    return card;
  },

  _statusNode(state, total) {
    if (state === "ACTIVE") {
      const wrap = el("span", "le-status le-status-live");
      wrap.innerHTML =
        `<svg class="le-ring" viewBox="0 0 18 18" width="16" height="16"><circle cx="9" cy="9" r="7" class="le-ring-track"/>` +
        `<circle cx="9" cy="9" r="7" class="le-ring-arc" stroke-dasharray="${RING_C}" stroke-dashoffset="0"/></svg>`;
      wrap.appendChild(el("span", "le-timer-text", "0:00"));
      wrap.dataset.total = String(total || 0);
      return wrap;
    }
    const wrap = el("span", "le-status");
    if (state === "LOCKED") { wrap.innerHTML = ICONS.lock; wrap.appendChild(el("span", null, "Locked")); }
    else wrap.textContent = state === "CANCELED" || state === "CANCEL_PENDING" ? "Canceled" : "Ended";
    return wrap;
  },

  // ---- prediction card ----
  _buildPredCard(d) {
    const s = this._leState();
    const status = this._predStatus(d);
    const ended = predEnded(d);
    const card = this._cardShell("pred", d, this._statusNode(status, d.window_seconds), ended);
    const body = el("div", "le-body");
    const colorOf = (o, i) => ((o.color || "").toUpperCase() === "PINK" || (!o.color && i === 1) ? "pink" : "blue");
    const canBet = status === "ACTIVE";
    const bet = s.myBets.get(d.id);
    const pick = (id) => {
      if (!canBet || (bet && bet.outcomeId !== id)) return;
      s.sel = id; s.error = "";
      this._leRender("pred");
    };

    if (d.outcomes.length === 2) {
      // head-to-head: one split bar + two sides
      const vs = el("div", "le-vs");
      const bar = el("div", "le-vs-bar");
      bar.append(el("span", "le-vs-fill blue"), el("span", "le-vs-fill pink"));
      const sides = el("div", "le-vs-sides");
      d.outcomes.forEach((o, i) => {
        const side = el("button", `le-side ${colorOf(o, i)}` + (i === 1 ? " right" : ""));
        side.type = "button";
        side.dataset.id = o.id;
        side.append(el("span", "le-side-pct"), el("span", "le-side-title", o.title), el("span", "le-side-meta"));
        side.addEventListener("click", () => pick(o.id));
        sides.appendChild(side);
      });
      vs.append(bar, sides);
      body.appendChild(vs);
    } else {
      const rows = el("div", "le-rows");
      d.outcomes.forEach((o, i) => {
        const row = el("button", `le-row ${colorOf(o, i)}`);
        row.type = "button";
        row.dataset.id = o.id;
        row.append(el("span", "le-row-fill"), el("span", "le-row-title", o.title), el("span", "le-row-meta"), el("span", "le-row-pct"));
        row.addEventListener("click", () => pick(o.id));
        rows.appendChild(row);
      });
      body.appendChild(rows);
    }

    if (ended) body.appendChild(el("div", "le-result"));
    else if (bet) body.appendChild(el("div", "le-mine"));

    if (canBet) {
      const betBox = el("div", "le-bet");
      const amounts = el("div", "le-amounts");
      const presets = [[10, "10"], [100, "100"], [1000, "1K"], [10000, "10K"], ["max", "Max"]];
      for (const [v, label] of presets) {
        const b = el("button", "le-chip", label);
        b.type = "button";
        b.dataset.v = String(v);
        b.addEventListener("click", () => {
          const bal = this._leBalance();
          s.amount = String(v === "max" ? Math.min(MAX_BET, bal || 0) : v);
          s.error = "";
          const input = betBox.querySelector(".le-amount-input");
          if (input) input.value = s.amount;
          this._leRender("pred");
        });
        amounts.appendChild(b);
      }
      const input = el("input", "le-amount-input");
      input.type = "number"; input.min = "1"; input.placeholder = "Amount"; input.inputMode = "numeric";
      input.value = s.amount;
      input.addEventListener("input", () => { s.amount = input.value; s.error = ""; this._leRender("pred"); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
      amounts.appendChild(input);
      const foot = el("div", "le-bet-foot");
      const info = el("div", "le-bet-info");
      const go = el("button", "le-go");
      go.type = "button";
      go.addEventListener("click", () => { const cur = this._leData("pred"); if (cur) this._lePlaceBet(cur); });
      foot.append(info, go);
      betBox.append(amounts, foot, el("div", "le-error"));
      body.appendChild(betBox);
    }
    card.appendChild(body);
    return card;
  },

  _updatePredCard(slot, d) {
    const s = this._leState();
    const card = slot.querySelector(".le-card");
    if (!card) return;
    const total = d.outcomes.reduce((a, o) => a + (o.total_points || 0), 0);
    const pctOf = (o) => (total > 0 ? Math.round(((o.total_points || 0) / total) * 100) : 0);
    const ratioOf = (o) => (o.total_points > 0 ? `1:${(total / o.total_points).toFixed(2)}` : "1:—");
    const winner = d.winning_outcome_id;
    const bet = s.myBets.get(d.id);
    const selId = bet ? bet.outcomeId : s.sel;
    const status = this._predStatus(d);

    if (d.outcomes.length === 2) {
      const [a, b] = d.outcomes;
      const pa = total > 0 ? (a.total_points / total) * 100 : 50;
      const fills = card.querySelectorAll(".le-vs-fill");
      if (fills[0]) fills[0].style.width = `${pa}%`;
      if (fills[1]) fills[1].style.width = `${100 - pa}%`;
    }
    card.querySelectorAll("[data-id]").forEach((node) => {
      const o = d.outcomes.find((x) => x.id === node.dataset.id);
      if (!o) return;
      const pct = pctOf(o);
      const pctEl = node.querySelector(".le-side-pct, .le-row-pct");
      const metaEl = node.querySelector(".le-side-meta, .le-row-meta");
      const fillEl = node.querySelector(".le-row-fill");
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (metaEl) metaEl.textContent = `${fmt(o.total_points)} pts · ${fmt(o.total_users)} · ${ratioOf(o)}`;
      if (fillEl) fillEl.style.width = `${pct}%`;
      node.classList.toggle("selected", selId === o.id);
      node.classList.toggle("winner", !!winner && winner === o.id);
      node.classList.toggle("loser", !!winner && winner !== o.id);
      node.classList.toggle("disabled", status !== "ACTIVE" || (!!bet && bet.outcomeId !== o.id));
      node.title = status === "ACTIVE" ? (bet && bet.outcomeId !== o.id ? "You already predicted the other outcome" : `Predict on ${o.title}`) : o.title;
    });

    const resultEl = card.querySelector(".le-result");
    if (resultEl) {
      const e = s.ended && s.ended.event.id === d.id ? s.ended : null;
      const r = e && e.result;
      const b = e ? e.bet : bet;
      resultEl.className = "le-result" + (r ? ` ${r.kind.toLowerCase()}` : " pending");
      resultEl.replaceChildren();
      const big = el("div", "le-result-big");
      const small = el("div", "le-result-small");
      if (!r && d.status !== "RESOLVED" && d.status !== "CANCELED") {
        big.textContent = "Waiting for the result…";
        small.textContent = b ? `You predicted ${fmtFull(b.points)} on ${(d.outcomes.find((o) => o.id === b.outcomeId) || {}).title || ""}` : "";
      } else {
        const kind = r ? r.kind : (b && winner ? (winner === b.outcomeId ? "WON" : "LOST") : "ENDED");
        const pts = r ? r.points : 0;
        const winTitle = winner ? (d.outcomes.find((o) => o.id === winner) || {}).title : "";
        big.textContent = kind === "WON" ? `You won ${fmtFull(pts)} points!`
          : kind === "LOST" ? `You lost ${fmtFull(pts)} points`
          : kind === "REFUND" ? `Canceled · ${fmtFull(pts)} points refunded`
          : kind === "CANCELED" ? "Prediction canceled"
          : kind === "UNKNOWN" ? "Prediction ended"
          : winTitle ? `${winTitle} won` : "Prediction ended";
        const parts = [];
        if (winTitle && (kind === "WON" || kind === "LOST")) parts.push(`${winTitle} won`);
        if (kind === "UNKNOWN") parts.push("Couldn't confirm your result");
        if (r && r.inferred && (kind === "WON" || kind === "LOST" || kind === "REFUND")) parts.push("based on your points balance");
        small.textContent = parts.join(" · ");
      }
      resultEl.append(big);
      if (small.textContent) resultEl.append(small);
    }
    const mine = card.querySelector(".le-mine");
    if (mine && bet) {
      const o = d.outcomes.find((x) => x.id === bet.outcomeId);
      const potential = o && o.total_points > 0 ? Math.floor(bet.points * (total / o.total_points)) : 0;
      mine.replaceChildren();
      mine.innerHTML = ICONS.check;
      const t = el("span");
      if (winner) {
        t.textContent = winner === bet.outcomeId
          ? `You won about ${fmtFull(potential)} points on ${o ? o.title : ""}`
          : `You predicted ${fmtFull(bet.points)} on ${o ? o.title : ""}. Better luck next time`;
      } else {
        t.textContent = `You predicted ${fmtFull(bet.points)} on ${o ? o.title : ""} · potential win ${fmtFull(potential)}`;
      }
      mine.appendChild(t);
    }

    const betBox = card.querySelector(".le-bet");
    if (betBox) {
      const bal = this._leBalance();
      const amt = Math.floor(Number(s.amount) || 0);
      const o = d.outcomes.find((x) => x.id === selId);
      const info = betBox.querySelector(".le-bet-info");
      const go = betBox.querySelector(".le-go");
      const potential = o && amt > 0 ? Math.floor(amt * ((total + amt) / ((o.total_points || 0) + amt))) : 0;
      info.textContent = bal != null ? `Balance ${fmtFull(bal)}` + (potential ? ` · win ~${fmt(potential)}` : "") : (potential ? `Win ~${fmt(potential)}` : "");
      const tooMuch = bal != null && amt > bal;
      go.disabled = !o || amt <= 0 || tooMuch || amt > MAX_BET || s.busy;
      go.classList.toggle("pink", !!o && (o.color || "").toUpperCase() === "PINK");
      go.textContent = s.busy ? "Predicting…"
        : !o ? "Pick an outcome"
        : amt <= 0 ? `Enter an amount`
        : tooMuch ? "Not enough points"
        : `${bet ? "Add" : "Predict"} ${fmt(amt)} on ${o.title}`;
      betBox.querySelectorAll(".le-chip").forEach((c) => {
        const v = c.dataset.v === "max" ? Math.min(MAX_BET, bal || 0) : Number(c.dataset.v);
        c.classList.toggle("on", amt > 0 && v === amt);
        c.disabled = bal != null && v > bal;
      });
      const errEl = betBox.querySelector(".le-error");
      errEl.textContent = s.error || "";
      errEl.style.display = s.error ? "" : "none";
    }
  },

  async _lePlaceBet(d) {
    const s = this._leState();
    const amt = Math.floor(Number(s.amount) || 0);
    const bet = s.myBets.get(d.id);
    const outcomeId = bet ? bet.outcomeId : s.sel;
    if (!outcomeId || amt <= 0 || s.busy) return;
    s.busy = true; s.error = "";
    this._leRender("pred");
    try {
      await invoke("make_prediction", { eventId: d.id, outcomeId, points: amt });
      if (s.balance != null) s.balance = Math.max(0, s.balance - amt);
      s.myBets.set(d.id, { outcomeId, points: (bet ? bet.points : 0) + amt });
      s.amount = "";
    } catch (err) {
      s.error = typeof err === "string" ? err : (err && err.message) || "Couldn't place the prediction";
    } finally {
      s.busy = false;
      this._leRender("pred");
    }
  },

  // ---- poll card ----
  _buildPollCard(d) {
    const s = this._leState();
    const ended = pollEnded(d);
    const card = this._cardShell("poll", d, this._statusNode(ended ? "ENDED" : "ACTIVE", d.duration_seconds), ended);
    const body = el("div", "le-body");
    const rows = el("div", "le-rows");
    const voted = s.myVotes.get(d.id);
    d.choices.forEach((c) => {
      const row = el("button", "le-row poll");
      row.type = "button";
      row.dataset.id = c.id;
      const check = el("span", "le-row-check");
      check.innerHTML = ICONS.check;
      row.append(el("span", "le-row-fill"), check, el("span", "le-row-title", c.title), el("span", "le-row-meta"), el("span", "le-row-pct"));
      row.addEventListener("click", () => { const cur = this._leData("poll"); if (cur) this._leVote(cur, c.id); });
      if (ended || voted) row.classList.add("disabled");
      rows.appendChild(row);
    });
    body.append(rows, el("div", "le-poll-foot"), el("div", "le-error"));
    card.appendChild(body);
    return card;
  },

  _updatePollCard(slot, d) {
    const s = this._leState();
    const card = slot.querySelector(".le-card");
    if (!card) return;
    const total = d.choices.reduce((a, c) => a + (c.votes || 0), 0);
    const top = Math.max(0, ...d.choices.map((c) => c.votes || 0));
    const voted = s.myVotes.get(d.id);
    const ended = pollEnded(d);
    card.querySelectorAll(".le-row[data-id]").forEach((row) => {
      const c = d.choices.find((x) => x.id === row.dataset.id);
      if (!c) return;
      const pct = total > 0 ? Math.round(((c.votes || 0) / total) * 100) : 0;
      row.querySelector(".le-row-fill").style.width = `${pct}%`;
      row.querySelector(".le-row-pct").textContent = `${pct}%`;
      row.querySelector(".le-row-meta").textContent = fmt(c.votes);
      row.classList.toggle("selected", voted === c.id);
      row.classList.toggle("leading", total > 0 && (c.votes || 0) === top);
      row.title = ended ? c.title : voted ? (voted === c.id ? "Your vote" : c.title) : `Vote for ${c.title}`;
    });
    const foot = card.querySelector(".le-poll-foot");
    if (foot) foot.textContent = `${fmtFull(total)} vote${total === 1 ? "" : "s"}` + (voted ? " · you voted" : ended ? "" : " · click a choice to vote");
    const errEl = card.querySelector(".le-error");
    if (errEl) { errEl.textContent = s.error || ""; errEl.style.display = s.error ? "" : "none"; }
  },

  async _leVote(d, choiceId) {
    const s = this._leState();
    if (pollEnded(d) || s.myVotes.has(d.id)) return;
    s.myVotes.set(d.id, choiceId); // optimistic
    s.error = "";
    const c = d.choices.find((x) => x.id === choiceId);
    if (c) c.votes = (c.votes || 0) + 1;
    this._leRender("poll");
    try {
      await invoke("vote_on_poll", { pollId: d.id, choiceId });
    } catch (err) {
      s.myVotes.delete(d.id);
      if (c) c.votes = Math.max(0, (c.votes || 0) - 1);
      s.error = typeof err === "string" ? err : "Couldn't vote";
      this._leRender("poll");
    }
  },
};
