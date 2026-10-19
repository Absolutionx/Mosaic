// Points & Drops > Ledger: what points-ledger.js recorded, for the channel you're on and across channels.
//   left: totals for the range, a day-by-day chart (earned stacked above the line by source, spending below),
//         a "saving for" goal, and the activity list
//   right: your channels ranked by what watching earns there per hour
// Colors: three categorical series + a neutral for spending, checked with the dataviz palette validator against
// Mosaic's dark and light surfaces (styles.css .lg).

import {
  CATEGORY, ledgerEvents, ledgerChannels, summarize, getGoal, setGoal, onLedgerChange, ledgerBalance,
} from "./points-ledger.js";

const RANGES = [7, 14, 30, 90];
const CAT_LABEL = { watch: "Watching", chest: "Bonus chests", other: "Raids, streaks & predictions", spent: "Spent" };
const DAY = 86_400_000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Math.round(Number(n) || 0).toLocaleString();
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + num(Math.abs(n));
function dur(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
// calendar days, not 24-hour steps: a day with a daylight saving change is 23 or 25 hours long, and stepping by
// 24h from midnight would drift an hour off midnight after it (bars on the wrong day, no "Today")
function addDays(dayStart, n) { const d = new Date(dayStart); d.setDate(d.getDate() + n); d.setHours(0, 0, 0, 0); return d.getTime(); }
const daysBetween = (fromStart, toStart) => Math.round((toStart - fromStart) / DAY);
function dayLabel(t, today) {
  const s = startOfDay(t);
  if (s === today) return "Today";
  if (s === addDays(today, -1)) return "Yesterday";
  return new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function getRange() {
  try { const v = Number(localStorage.getItem("ledgerRange")); if (RANGES.includes(v)) return v; } catch { /* ignore */ }
  return 14;
}
function hue(login) {
  let h = 0;
  for (const ch of String(login)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 42%)`;
}

// what one event says in the activity list: [icon, category, title, detail]
function describe(e) {
  switch (e.k) {
    case "watch": return ["▶", "watch", `Watched ${esc(e.c)}`, `${clock(e.t)} – ${Date.now() - e.e < 3 * 60_000 ? "now" : clock(e.e)}, ${dur(e.m)}`];
    case "chest": return ["◈", "chest", `${e.n || 1} bonus chest${(e.n || 1) === 1 ? "" : "s"}`, "auto-claimed"];
    case "spend": return ["✦", "spent", esc(e.n2 || "Redeemed a reward"), ""];
    case "bet": return ["◆", "spent", esc(e.n2 || "Prediction"), "your bet"];
    case "predwin": return ["★", "other", "Won prediction", esc(e.n2 || "")];
    case "refund": return ["↺", "other", "Prediction refunded", esc(e.n2 || "")];
    case "streak": return ["🔥", "other", "Shared watch streak", ""];
    case "extra": return ["＋", "other", "Extra points", "a raid, streak or Twitch bonus"];
    // Mosaic wasn't watching this channel in between (another channel, Twitch's own site or app, Mosaic closed)
    case "away": return ["⏸", "other", "Earned while you were away", e.f ? `not watched here since ${new Date(e.f).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(e.f)}` : ""];
    case "awayx": return ["⏸", "spent", "Spent while you were away", e.f ? `not watched here since ${new Date(e.f).toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(e.f)}` : ""];
    case "spendx": return ["↗", "spent", "Spent outside Mosaic", "on Twitch's site or app"];
    default: return ["·", "other", esc(e.k), ""];
  }
}

// opts: { login (channel on screen or null), points (its balance or null), rewards (channel rewards), watching (login playing) }
export function renderLedger(body, opts) {
  let range = getRange();
  const openedAt = Date.now();
  let unsub = null;
  let hover = null;

  const draw = () => {
    if (!body.isConnected) { unsub?.(); return; }
    // redrawn every minute while you watch: keep where you'd scrolled to
    const keep = [".lg-col", ".lg-side"].map((sel) => body.querySelector(sel)?.scrollTop || 0);
    const login = opts.login ? String(opts.login).toLowerCase() : null;
    const now = Date.now();
    const today = startOfDay(now);
    const since = addDays(today, -(range - 1));
    const mine = login ? ledgerEvents(since, login) : [];
    const sum = summarize(mine);

    let left = "";
    if (!login) {
      left = `<div class="lg-empty">Open a channel to see its ledger. Your other channels are on the right.</div>`;
    } else {
      left += `<div class="lg-head">
          <div class="lg-big">${signed(sum.earned)}<small>earned</small></div>
          <div class="lg-stat"><b>${signed(sum.spent)}</b> spent</div>
          <div class="lg-stat"><b>${dur(sum.minutes)}</b> watched${sum.perHour != null ? ` · <b>${num(sum.perHour)}</b>/hr` : ""}</div>
          <div class="lg-range" role="group" aria-label="Range">${RANGES.map((r) => `<button type="button" data-r="${r}" class="${r === range ? "on" : ""}">${r} days</button>`).join("")}</div>
        </div>`;
      if (!mine.length) {
        left += `<div class="lg-empty">Nothing recorded for <b>${esc(login)}</b> in the last ${range} days yet. While you watch, Mosaic notes every minute what you earned, the bonus chests it claimed and what you spent, and it all shows up here.</div>`;
      } else {
        left += `<div class="lg-legend">${["watch", "chest", "other", "spent"].map((c) => `<span><i class="lg-sw lg-c-${c}"></i>${CAT_LABEL[c]}</span>`).join("")}</div>
          <div class="lg-chart" aria-label="Points by day"></div>`;
      }
      left += goalHtml(login, sum.perHour);
      if (mine.length) left += feedHtml(mine, today);
    }

    body.innerHTML = `<div class="lg">
        <div class="lg-col">${left}</div>
        <div class="lg-side">${sideHtml(since, login)}</div>
      </div>`;

    body.querySelectorAll(".lg-range button").forEach((b) => b.addEventListener("click", () => {
      range = Number(b.dataset.r) || 14;
      try { localStorage.setItem("ledgerRange", String(range)); } catch { /* ignore */ }
      draw();
    }));
    wireGoal(login);
    const chartEl = body.querySelector(".lg-chart");
    if (chartEl) drawChart(chartEl, mine, since, range, today);
    [".lg-col", ".lg-side"].forEach((sel, i) => { const n = body.querySelector(sel); if (n) n.scrollTop = keep[i]; });
  };

  // ---- goal: a reward you're saving for, with how long it'll take at your usual rate ----
  function goalHtml(login, rangeRate) {
    let goal = getGoal(login);
    // the streamer changed the reward's cost or name since you picked it: follow along
    const live = goal && (opts.rewards || []).find((x) => String(x.id) === String(goal.id));
    if (live && (live.cost !== goal.cost || live.title !== goal.title)) { setGoal(login, live); goal = getGoal(login); }
    // the balance: whichever is newer, what the panel loaded or the ledger's last check (every minute while you watch)
    const seen = ledgerChannels()[login];
    const bal = seen && seen.bal != null && (opts.points == null || seen.at > openedAt) ? Number(ledgerBalance(login)) : opts.points != null ? Number(opts.points) : null;
    if (goal && goal.cost > 0) {
      const have = bal != null ? bal : 0;
      const p = Math.max(0, Math.min(1, have / goal.cost));
      const left = Math.max(0, goal.cost - have);
      const rate = rangeRate || summarize(ledgerEvents(Date.now() - 30 * DAY, login)).perHour;
      const r = 17, c = 2 * Math.PI * r;
      const eta = left === 0 ? "You can redeem it now."
        : rate ? `${num(left)} to go · about ${dur(left / rate * 60)} of watching at your usual ${num(rate)}/hr`
        : `${num(left)} to go`;
      return `<div class="lg-goal">
          <svg class="lg-goal-ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--m-raised)" stroke-width="5"/><circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--m-accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 22 22)"/><text x="22" y="26" text-anchor="middle">${Math.round(p * 100)}%</text></svg>
          <div class="lg-goal-text">Saving for <b>${esc(goal.title)}</b> (◈ ${num(goal.cost)})<br><span>${bal == null ? "Your balance didn't load" : eta}</span></div>
          <div class="lg-goal-btns">${left === 0 && opts.onRedeem && bal != null ? `<button type="button" class="lg-link lg-link-go" data-goal="redeem">Redeem</button>` : ""}<button type="button" class="lg-link" data-goal="change">Change</button><button type="button" class="lg-link" data-goal="clear">Remove</button></div>
        </div><div class="lg-goal-pick" hidden></div>`;
    }
    if (!(opts.rewards || []).some((x) => x.cost > 0)) return "";
    return `<div class="lg-goal lg-goal-empty"><div class="lg-goal-text">Saving up for something?<br><span>Pick a reward and the ledger shows how close you are and how long it'll take.</span></div>
        <div class="lg-goal-btns"><button type="button" class="lg-link" data-goal="change">Pick a reward</button></div></div><div class="lg-goal-pick" hidden></div>`;
  }

  function wireGoal(login) {
    const pick = body.querySelector(".lg-goal-pick");
    body.querySelectorAll("[data-goal]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.goal === "clear") { setGoal(login, null); return; }
      if (b.dataset.goal === "redeem") { opts.onRedeem?.(); return; }
      if (!pick) return;
      if (!pick.hidden) { pick.hidden = true; return; }
      const list = [...(opts.rewards || [])].filter((x) => x.cost > 0).sort((a, b2) => b2.cost - a.cost);
      pick.innerHTML = list.map((x) => `<button type="button" class="lg-pick-row" data-id="${esc(x.id)}">
          ${x.image ? `<img src="${esc(x.image)}" alt="">` : `<span class="lg-pick-fallback">◈</span>`}
          <span class="lg-pick-title">${esc(x.title)}</span><span class="lg-pick-cost">◈ ${num(x.cost)}</span></button>`).join("");
      pick.hidden = false;
      pick.querySelectorAll(".lg-pick-row").forEach((row) => row.addEventListener("click", () => {
        const x = list.find((y) => String(y.id) === row.dataset.id);
        pick.hidden = true; // first: saving redraws, and nothing redraws while the picker is open
        if (x) setGoal(login, x);
      }));
    }));
  }

  // ---- activity list, newest first, grouped by day ----
  function feedHtml(events, today) {
    const shown = [...events].filter((e) => e.a !== 0 || (e.k === "watch" && e.m >= 1))
      .sort((a, b) => (b.e || b.t) - (a.e || a.t)).slice(0, 150);
    let html = `<div class="lg-feed">`, lastDay = null;
    for (const e of shown) {
      const t = e.e || e.t;
      const d = startOfDay(t);
      if (d !== lastDay) { html += `<div class="lg-day">${dayLabel(t, today)}</div>`; lastDay = d; }
      const [icon, cat, title, detail] = describe(e);
      html += `<div class="lg-row"><span class="lg-ico lg-c-${cat}" aria-hidden="true">${icon}</span>
        <span class="lg-what">${title}${detail ? ` <span>· ${detail}</span>` : ""}</span>
        <span class="lg-amt ${e.a < 0 ? "minus" : "plus"}">${e.a ? signed(e.a) : ""}</span>
        <span class="lg-time">${clock(t)}</span></div>`;
    }
    return html + `</div>`;
  }

  // ---- your channels, best points per hour first ----
  function sideHtml(since, login) {
    const chans = ledgerChannels();
    const rows = Object.keys(chans).map((c) => {
      const s = summarize(ledgerEvents(since, c));
      return { c, bal: chans[c].bal, ...s };
    }).filter((r) => r.earned || r.spent || r.minutes);
    rows.sort((a, b) => (b.perHour ?? -1) - (a.perHour ?? -1) || b.earned - a.earned);
    const best = Math.max(1, ...rows.map((r) => r.perHour || 0));
    const total = Object.values(chans).reduce((a, x) => a + (Number(x.bal) || 0), 0);
    let html = `<h4>Across your channels</h4><p>Where watching pays off most, last ${range} days</p>`;
    if (!rows.length) html += `<div class="lg-empty small">Channels show up here once Mosaic has seen you earn points on them.</div>`;
    for (const r of rows.slice(0, 8)) {
      const here = opts.watching && r.c === String(opts.watching).toLowerCase();
      html += `<div class="lg-ch${r.c === login ? " current" : ""}">
          <span class="lg-av" style="background:${hue(r.c)}">${esc(r.c.slice(0, 2).toUpperCase())}</span>
          <div class="lg-ch-main"><div class="lg-ch-name">${esc(r.c)}${here ? `<span class="lg-here">Watching</span>` : ""}</div>
            <div class="lg-ch-sub">◈ ${r.bal != null ? num(r.bal) : "?"} · ${signed(r.earned)} earned</div>
            <div class="lg-meter"><span style="width:${r.perHour ? Math.round(r.perHour / best * 100) : 0}%"></span></div></div>
          <div class="lg-ch-rate">${r.perHour != null ? num(r.perHour) : "–"}<span>per hour</span></div>
        </div>`;
    }
    const chestShare = (() => {
      const ev = ledgerEvents(since);
      const earned = ev.reduce((a, e) => a + (e.a > 0 ? e.a : 0), 0);
      const chests = ev.reduce((a, e) => a + (e.k === "chest" ? e.a : 0), 0);
      return earned >= 500 ? Math.round(chests / earned * 100) : null;
    })();
    if (Object.keys(chans).length) {
      html += `<div class="lg-foot">◈ ${num(total)} across ${Object.keys(chans).length} channel${Object.keys(chans).length === 1 ? "" : "s"}${chestShare != null ? ` · bonus chests were ${chestShare}% of what you earned` : ""}</div>`;
    }
    return html;
  }

  // ---- the chart: one bar per day, earnings stacked up by source, spending hanging below ----
  function drawChart(el, events, since, days, today) {
    const buckets = Array.from({ length: days }, (_, i) => ({ t: addDays(since, i), watch: 0, chest: 0, other: 0, spent: 0, min: 0, chests: 0, notes: [] }));
    for (const e of events) {
      const i = daysBetween(since, startOfDay(e.t));
      const b = buckets[i];
      if (!b) continue;
      const cat = CATEGORY[e.k] || "other";
      if (cat === "spent") b.spent += e.a; else b[cat] += e.a;
      if (e.k === "watch") b.min += e.m || 0;
      if (e.k === "chest") b.chests += e.n || 1;
      if (cat === "other" || cat === "spent") b.notes.push(e);
    }
    const W = Math.max(280, el.clientWidth || 560), H = 180, top = 10, bottom = 22, left = 34;
    const upMax = Math.max(500, ...buckets.map((b) => b.watch + b.chest + b.other));
    const dnMax = Math.max(0, ...buckets.map((b) => -b.spent));
    const nice = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; };
    // one scale for both directions; spending may hang down at most 60% of the earnings height, and a bigger
    // spend is drawn to the edge with a notch (the tooltip has the real number)
    const up = nice(upMax), dn = dnMax ? Math.min(nice(dnMax), nice(up * 0.6)) : 0;
    const plotH = H - top - bottom;
    const unit = plotH / (up + dn);
    const zeroY = top + up * unit;
    const yUp = (v) => v * unit;
    const yDn = (v) => Math.min(v, dn) * unit;
    const slot = (W - left) / days;
    const bw = Math.max(3, Math.min(26, slot * 0.62));
    const r = bw >= 10 ? 4 : 2;
    const fmtK = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(v));
    let svg = "";
    for (const v of [up / 2, up]) {
      const y = zeroY - yUp(v);
      svg += `<line class="lg-grid" x1="${left}" x2="${W}" y1="${y}" y2="${y}"/><text x="${left - 6}" y="${y + 3.5}" text-anchor="end">${fmtK(v)}</text>`;
    }
    if (dn) svg += `<line class="lg-grid dash" x1="${left}" x2="${W}" y1="${zeroY + yDn(dn)}" y2="${zeroY + yDn(dn)}"/><text x="${left - 6}" y="${zeroY + yDn(dn) + 3.5}" text-anchor="end">−${fmtK(dn)}</text>`;
    svg += `<text x="${left - 6}" y="${zeroY + 3.5}" text-anchor="end">0</text>`;
    const labelEvery = days <= 7 ? 1 : days <= 14 ? 3 : days <= 30 ? 7 : 14;
    buckets.forEach((b, i) => {
      const x = left + i * slot + (slot - bw) / 2;
      let y = zeroY;
      const segs = [["watch", b.watch], ["chest", b.chest], ["other", b.other]].filter(([, v]) => v > 0);
      segs.forEach(([cat, v], k) => {
        const h = yUp(v);
        const last = k === segs.length - 1;
        const hh = Math.max(1, h - (last ? 0 : 2)); // a 2px gap between stacked pieces
        y -= h;
        const rr = last ? Math.min(r, hh) : 0;
        svg += last
          ? `<path class="lg-c-${cat}" d="M${x},${y + hh} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + bw - rr} Q${x + bw},${y} ${x + bw},${y + rr} V${y + hh} Z"/>`
          : `<rect class="lg-c-${cat}" x="${x}" y="${y + 2}" width="${bw}" height="${hh}"/>`;
      });
      if (b.spent < 0) {
        const h = Math.max(2, yDn(-b.spent)), y0 = zeroY + 2, rr = Math.min(r, h);
        svg += `<path class="lg-c-spent" d="M${x},${y0} V${y0 + h - rr} Q${x},${y0 + h} ${x + rr},${y0 + h} H${x + bw - rr} Q${x + bw},${y0 + h} ${x + bw},${y0 + h - rr} V${y0} Z"/>`;
        if (-b.spent > dn) svg += `<path class="lg-clip" d="M${x - 2},${y0 + h - 5} l${(bw + 4) / 2},4 l${(bw + 4) / 2},-4"/>`;
      }
      const isToday = b.t === today;
      if (isToday || (days - 1 - i) % labelEvery === 0 && i < days - Math.ceil(labelEvery / 2)) {
        svg += `<text class="${isToday ? "today" : ""}" x="${x + bw / 2}" y="${H - 5}" text-anchor="middle">${isToday ? "Today" : new Date(b.t).toLocaleDateString([], { month: "short", day: "numeric" })}</text>`;
      }
      svg += `<rect class="lg-hit" data-i="${i}" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>`;
    });
    svg += `<line class="lg-zero" x1="${left}" x2="${W}" y1="${zeroY + 1}" y2="${zeroY + 1}"/>`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${svg}</svg><div class="lg-tip" hidden></div>`;

    const tip = el.querySelector(".lg-tip");
    const show = (i) => {
      const b = buckets[i];
      el.querySelectorAll(".lg-hit").forEach((h) => h.classList.toggle("on", Number(h.dataset.i) === i));
      const lines = [];
      if (b.watch || b.min >= 1) lines.push(["watch", `Watching${b.min >= 1 ? ` (${dur(b.min)})` : ""}`, b.watch]);
      if (b.chest) lines.push(["chest", `${b.chests} bonus chest${b.chests === 1 ? "" : "s"}`, b.chest]);
      for (const e of b.notes.slice(0, 5)) { const d = describe(e); lines.push([d[1], d[2], e.a]); }
      if (b.notes.length > 5) lines.push(["other", `${b.notes.length - 5} more`, null]);
      if (!lines.length) lines.push(["none", "Nothing recorded", null]);
      tip.innerHTML = `<div class="t">${new Date(b.t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>`
        + lines.map(([cat, label, a]) => `<div class="r"><span><i class="lg-sw lg-c-${cat}"></i>${label}</span><b>${a != null && a !== 0 ? signed(a) : ""}</b></div>`).join("");
      tip.hidden = false;
      const x = left + i * slot + slot / 2;
      const tw = tip.offsetWidth;
      tip.style.left = `${x + 14 + tw > W ? Math.max(0, x - 14 - tw) : x + 14}px`;
      tip.style.top = "0px";
    };
    el.querySelectorAll(".lg-hit").forEach((h) => {
      h.addEventListener("mouseenter", () => { hover = Number(h.dataset.i); show(hover); });
    });
    el.addEventListener("mouseleave", () => { hover = null; tip.hidden = true; el.querySelectorAll(".lg-hit.on").forEach((h) => h.classList.remove("on")); });
  }

  draw();
  // new checks arrive every minute while you watch; redraw unless you're pointing at the chart
  unsub = onLedgerChange(() => {
    // not while you're pointing at the chart or picking a reward to save for
    if (hover == null && !body.querySelector(".lg-goal-pick:not([hidden])")) draw();
  });
  return () => unsub?.();
}
