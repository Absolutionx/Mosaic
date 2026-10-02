// Hype train, the full version: a banner atop chat (level, animated fill, %, countdown) that expands into
// details (points to the next level, total, bits / subs / gift subs breakdown, conductors, emotes unlocked at
// this level, the channel's record, recent contributions from chat), a level-up celebration over the video,
// the "approaching" stage before a train starts and an end summary afterwards. Golden Kappa and the
// streamer's own train color theme it.
//
// Data: GetHypeTrainExecution (Rust get_hype_train) passes Twitch's whole execution / approaching objects
// through. Everything optional is read defensively: a section whose data Twitch doesn't send is left out.

const SUMMARY_MS = 20000, FEED_MAX = 8;

// ---- data ----
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");

// Twitch participations: [{ source: "BITS" | "SUBS", action: "CHEER" | "TIER_1_SUB" | "TIER_1_GIFTED_SUB" | ..., quantity }]
export function sumParticipations(list) {
  const out = { bits: 0, subs: 0, gifts: 0 };
  for (const p of Array.isArray(list) ? list : []) {
    const q = num(p?.quantity), src = String(p?.source || "").toUpperCase(), act = String(p?.action || "").toUpperCase();
    if (src === "BITS" || act.includes("BITS") || act === "CHEER") out.bits += q;
    else if (act.includes("GIFT")) out.gifts += q;
    else if (src === "SUBS" || act.includes("SUB")) out.subs += q;
  }
  return out;
}

export function parseHype(d) {
  if (!d) return null;
  const ex = d.execution && typeof d.execution === "object" ? d.execution : null;
  const prog = ex?.progress || {};
  const level = num(first(d.level, prog.level?.value));
  const conductors = (Array.isArray(ex?.conductors) ? ex.conductors : []).map((c) => {
    const parts = sumParticipations(c?.participations);
    return {
      source: String(c?.source || "").toUpperCase(),
      name: first(c?.user?.displayName, c?.user?.login, "Someone"),
      login: c?.user?.login || "",
      avatar: c?.user?.profileImageURL || "",
      ...parts,
    };
  });
  const rewards = (Array.isArray(prog.level?.rewards) ? prog.level.rewards : [])
    .map((r) => r?.emote || r)
    .filter((e) => e && e.id)
    .map((e) => ({ id: String(e.id), token: e.token || e.text || "" }));
  const record = num(first(ex?.allTimeHigh?.level?.value, ex?.allTimeHigh?.progress?.level?.value, ex?.allTimeHighLevel, ex?.allTimeHigh?.level));
  const hex = ex?.config?.willUseCreatorColor !== false ? first(ex?.config?.primaryHexColor, ex?.config?.creatorColor) : null;
  const a = d.approaching && typeof d.approaching === "object" ? d.approaching : null;
  const goals = Array.isArray(a?.goals) ? a.goals.map(num).filter((n) => n > 0) : [];
  return {
    active: !!d.active,
    ended: !!d.ended,
    level,
    progress: num(first(d.progress, prog.progression)),
    goal: num(first(d.goal, prog.goal)),
    total: num(first(d.total, prog.total)),
    golden: !!(d.is_golden || ex?.isGoldenKappaTrain),
    expiresAt: first(d.expires_at, ex?.expiresAt, ""),
    startedAt: ex?.startedAt || "",
    endedAt: ex?.endedAt || "",
    endingReason: String(ex?.endingReason || "").toUpperCase(),
    color: hex ? (String(hex).startsWith("#") ? hex : `#${hex}`) : "",
    contributions: sumParticipations(ex?.participations),
    conductors,
    rewards,
    record,
    approaching: a ? {
      expiresAt: a.expiresAt || "",
      needed: goals.length ? Math.max(...goals) : 0,
      have: Array.isArray(a.participants) ? a.participants.length : num(a.participantsCount),
      golden: !!a.isGoldenKappaTrain,
    } : null,
  };
}

// ---- view ----
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (n) => Number(n || 0).toLocaleString();
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const TRAIN_SVG = '<svg viewBox="0 0 15 13" width="15" height="13" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.1.55H2.4v4.25H.7v5.95h.85a1.7 1.7 0 0 0 3.4 0h.85a1.7 1.7 0 0 0 3.4 0h.85a1.7 1.7 0 0 0 3.4 0h.85V.55H6.65v1.7h.85v2.55H4.1V.55zM12.6 9.05V6.5H2.4v2.55h10.2zM9.2 4.8h3.4V2.25H9.2V4.8z"/></svg>';

export class HypeTrainView {
  // opts: { banner (chat slot), player (#video-region), getSetting, playChime }
  constructor(opts) {
    this.o = opts;
    this.model = null;
    this.mode = "none";      // none | active | approaching | ended
    this.expanded = false;
    this.feed = [];
    this.summaryTimer = null;
    this.tickTimer = null;
    this.o.banner?.addEventListener("click", (e) => {
      if (this.mode !== "active" || e.target.closest(".hype-details")) return;
      this.expanded = !this.expanded;
      this.render();
    });
  }

  msLeft(iso) {
    const t = Date.parse(iso || "");
    return Number.isFinite(t) ? t - Date.now() : 0;
  }

  // a running train
  update(model, { levelUp = false } = {}) {
    clearTimeout(this.summaryTimer);
    if (this.mode !== "active") this.feed = [];
    this.model = model;
    this.mode = "active";
    // the channel's record (all-time high) is beaten once this train climbs past it
    this.newRecord = !!(model.record && model.level > model.record);
    this.render({ levelUp });
    this.startTick();
    if (levelUp) this.celebrate(model);
  }

  // before a train starts: "approaching, N more contributions"
  showApproaching(model) {
    if (!model?.approaching) { this.clear(); return; }
    this.model = model;
    this.mode = "approaching";
    this.render();
    this.startTick();
  }

  // a train just ended: a summary for a while, then gone
  showEnded(model) {
    this.model = { ...(this.model || {}), ...model };
    this.mode = "ended";
    this.expanded = false;
    this.render();
    this.stopTick();
    clearTimeout(this.summaryTimer);
    this.summaryTimer = setTimeout(() => this.clear(), SUMMARY_MS);
  }

  // a contribution seen in chat while a train runs (subs, gifts, cheers)
  addContribution(who, what) {
    if (this.mode !== "active") return;
    this.feed.unshift({ who, what, at: Date.now() });
    this.feed.length = Math.min(this.feed.length, FEED_MAX);
    if (this.expanded) this.render();
  }

  clear() {
    clearTimeout(this.summaryTimer);
    this.stopTick();
    this.mode = "none";
    this.model = null;
    this.expanded = false;
    this.feed = [];
    if (this.o.banner) { this.o.banner.style.display = "none"; this.o.banner.replaceChildren(); }
  }

  startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), 1000);
  }
  stopTick() { clearInterval(this.tickTimer); this.tickTimer = null; }
  tick() {
    const m = this.model;
    if (!m) return;
    const iso = this.mode === "approaching" ? m.approaching?.expiresAt : m.expiresAt;
    const left = this.msLeft(iso);
    if (this.mode === "active" && iso && left <= 0) { this.showEnded({ ...m, ended: true }); return; }
    if (this.mode === "approaching" && iso && left <= 0) { this.clear(); return; }
    for (const c of document.querySelectorAll(".hype-clock")) c.textContent = fmtClock(left);
    const ring = this.o.banner?.querySelector(".hype-ring-fill");
    if (ring && m.startedAt && iso) {
      const totalMs = Date.parse(iso) - Date.parse(m.startedAt);
      if (totalMs > 0) ring.style.strokeDashoffset = String(100 - Math.max(0, Math.min(100, (left / totalMs) * 100)));
    }
  }

  theme(node, m) {
    node.classList.toggle("golden", !!m.golden);
    if (m.color && !m.golden) node.style.setProperty("--hype-color", m.color);
    else node.style.removeProperty("--hype-color");
  }

  render({ levelUp = false } = {}) {
    const b = this.o.banner, m = this.model;
    if (!b || !m) return;
    if (!this.o.getSetting("hypeGiftBanners")) { b.style.display = "none"; return; }
    b.replaceChildren();
    b.className = `hype-train-banner hype-${this.mode}` + (this.expanded ? " expanded" : "");
    this.theme(b, m);
    if (this.mode === "approaching") this.renderApproaching(b, m);
    else if (this.mode === "ended") this.renderEnded(b, m);
    else this.renderActive(b, m, levelUp);
    b.style.display = "block";
  }

  renderActive(b, m, levelUp) {
    const pct = m.goal > 0 ? Math.min(100, Math.round((m.progress / m.goal) * 100)) : 0;
    const fill = el("div", "hype-fill");
    fill.style.width = `${pct}%`;
    const row = el("div", "hype-row");
    const left = el("span", "hype-left");
    left.innerHTML = TRAIN_SVG;
    left.appendChild(el("span", "hype-level", `${m.golden ? "Golden Kappa · " : ""}LVL ${m.level}`));
    if (this.newRecord) left.appendChild(el("span", "hype-record", "NEW RECORD!"));
    const right = el("span", "hype-right");
    right.appendChild(el("span", "hype-pct", levelUp ? "LEVEL UP!" : `${pct}%`));
    const clock = el("span", "hype-clock-wrap");
    clock.innerHTML = '<svg class="hype-ring" viewBox="0 0 36 36" width="14" height="14"><circle cx="18" cy="18" r="15.9" pathLength="100" class="hype-ring-bg"/><circle cx="18" cy="18" r="15.9" pathLength="100" class="hype-ring-fill"/></svg>';
    clock.appendChild(el("span", "hype-clock", fmtClock(this.msLeft(m.expiresAt))));
    right.appendChild(clock);
    right.appendChild(el("span", "hype-chevron", this.expanded ? "▴" : "▾"));
    row.append(left, right);
    b.append(fill, row);
    if (levelUp) { b.classList.add("level-up"); setTimeout(() => b.classList.remove("level-up"), 2500); }
    if (this.expanded) b.appendChild(this.details(m));
  }

  details(m) {
    const d = el("div", "hype-details");
    const stat = (label, value) => { const s = el("div", "hype-stat"); s.append(el("div", "hype-stat-value", value), el("div", "hype-stat-label", label)); return s; };
    const stats = el("div", "hype-stats");
    if (m.goal) stats.appendChild(stat(`to Level ${m.level + 1}`, `${fmt(Math.max(0, m.goal - m.progress))} pts`));
    if (m.total) stats.appendChild(stat("total this train", fmt(m.total)));
    if (m.record) stats.appendChild(stat("channel record", `Level ${m.record}`));
    if (m.startedAt) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(m.startedAt)) / 60000));
      stats.appendChild(stat("running", `${mins} min`));
    }
    if (stats.children.length) d.appendChild(stats);
    const c = m.contributions;
    if (c && (c.bits || c.subs || c.gifts)) {
      d.appendChild(el("div", "hype-sub", "Contributions"));
      const chips = el("div", "hype-chips");
      if (c.bits) chips.appendChild(el("span", "hype-chip bits", `${fmt(c.bits)} bits`));
      if (c.subs) chips.appendChild(el("span", "hype-chip subs", `${fmt(c.subs)} subs`));
      if (c.gifts) chips.appendChild(el("span", "hype-chip gifts", `${fmt(c.gifts)} gift subs`));
      d.appendChild(chips);
    }
    if (m.conductors.length) {
      d.appendChild(el("div", "hype-sub", "Conductors"));
      for (const k of m.conductors) {
        const r = el("div", "hype-conductor");
        const av = el("span", "hype-av");
        if (k.avatar) { const img = el("img"); img.src = k.avatar; img.alt = ""; av.appendChild(img); } else av.textContent = (k.name[0] || "?").toUpperCase();
        const what = [k.bits ? `${fmt(k.bits)} bits` : "", k.subs ? `${fmt(k.subs)} subs` : "", k.gifts ? `${fmt(k.gifts)} gifted` : ""].filter(Boolean).join(" · ");
        const txt = el("span", "hype-conductor-text");
        txt.append(el("span", "hype-conductor-name", k.name), el("span", "hype-conductor-what", `${k.source === "BITS" ? "Bits" : k.source === "SUBS" ? "Subs" : "Top"} conductor${what ? ` · ${what}` : ""}`));
        r.append(av, txt);
        d.appendChild(r);
      }
    }
    if (m.rewards.length) {
      d.appendChild(el("div", "hype-sub", `Level ${m.level} rewards`));
      const row = el("div", "hype-rewards");
      for (const e of m.rewards) {
        const img = el("img", "hype-reward");
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(e.id)}/default/dark/2.0`;
        img.alt = e.token; img.title = e.token;
        row.appendChild(img);
      }
      d.appendChild(row);
    }
    if (this.feed.length) {
      d.appendChild(el("div", "hype-sub", "Recent"));
      for (const f of this.feed) {
        const r = el("div", "hype-feed-row");
        r.append(el("span", "hype-feed-who", f.who), el("span", "hype-feed-what", f.what));
        d.appendChild(r);
      }
    }
    return d;
  }

  renderApproaching(b, m) {
    const a = m.approaching;
    const row = el("div", "hype-row");
    const left = el("span", "hype-left");
    left.innerHTML = TRAIN_SVG;
    left.appendChild(el("span", "hype-level", a.golden ? "Golden Kappa train approaching" : "Hype train approaching"));
    const right = el("span", "hype-right");
    if (a.needed) {
      const dots = el("span", "hype-dots");
      for (let i = 0; i < a.needed; i++) dots.appendChild(el("span", "hype-dot" + (i < a.have ? " on" : "")));
      right.appendChild(dots);
      const more = Math.max(0, a.needed - a.have);
      right.appendChild(el("span", "hype-pct", more ? `${more} more` : "starting!"));
    }
    if (a.expiresAt) right.appendChild(el("span", "hype-clock", fmtClock(this.msLeft(a.expiresAt))));
    row.append(left, right);
    b.appendChild(row);
  }

  renderEnded(b, m) {
    const row = el("div", "hype-row");
    const left = el("span", "hype-left");
    left.innerHTML = TRAIN_SVG;
    const reached = m.level ? `Level ${m.level}` : "the station";
    left.appendChild(el("span", "hype-level", `Hype train ended · reached ${reached}`));
    const right = el("span", "hype-right");
    if (m.total) right.appendChild(el("span", "hype-pct", `${fmt(m.total)} pts`));
    row.append(left, right);
    b.appendChild(row);
    const top = (m.conductors || [])[0];
    if (top || (m.record && m.level > m.record)) {
      const extra = el("div", "hype-ended-extra");
      if (m.record && m.level > m.record) extra.appendChild(el("span", "hype-record", "NEW CHANNEL RECORD!"));
      if (top) extra.appendChild(el("span", null, `Top conductor: ${top.name}`));
      b.appendChild(extra);
    }
  }

  // level up: big "LEVEL N" burst with confetti over the video (Settings > Chat; reduced with Reduce motion)
  celebrate(m) {
    if (this.o.getSetting("hypeTrainSound")) this.o.playChime?.({ preview: true });
    const host = this.o.player;
    if (!host || !this.o.getSetting("hypeTrainCelebrate")) return;
    const burst = el("div", "hype-burst" + (m.golden ? " golden" : ""));
    if (m.color && !m.golden) burst.style.setProperty("--hype-color", m.color);
    burst.appendChild(el("div", "hype-burst-text", `LEVEL ${m.level}!`));
    if (!this.o.getSetting("reduceMotion")) {
      for (let i = 0; i < 48; i++) {
        const p = el("span", "hype-confetti");
        p.style.setProperty("--x", `${Math.round(Math.random() * 100)}%`);
        p.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 240)}px`);
        p.style.setProperty("--d", `${(0.9 + Math.random() * 0.9).toFixed(2)}s`);
        p.style.setProperty("--delay", `${(Math.random() * 0.25).toFixed(2)}s`);
        p.style.setProperty("--hue", String(Math.round(Math.random() * 360)));
        burst.appendChild(p);
      }
    }
    host.appendChild(burst);
    setTimeout(() => burst.remove(), 2400);
  }
}
