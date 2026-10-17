// Drops hub: everything about Twitch Drops in one place.
//   In progress: campaigns you're earning (inventory), each drop's progress, time left, Claim. The campaign
//   the stream you're watching is earning comes first; ended campaigns are left out unless a reward is
//   still waiting to be claimed.
//   Available: every drop campaign on Twitch right now, with "Find streams" (opens the game in Browse) and
//   "Link account" when the game account isn't connected yet.
// Both use the Twitch connection (Settings > Twitch account). If Twitch rejects the "all campaigns" query,
// the hub says so and still shows your in-progress drops.

import { invoke } from "@tauri-apps/api/core";
import { pushEscape } from "./escape-stack.js";

let viewEl = null, popEscape = null, opts = {};
// the last load, kept so the search box can re-filter without asking Twitch again
let data = null, query = "";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function fmtLeft(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}
// "ends in 3 days", "ends today", "ended"
export function fmtEnds(iso, now = Date.now()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "";
  const ms = t - now;
  if (ms <= 0) return "Ended";
  const h = ms / 3600000;
  if (h < 1) return "Ends within the hour";
  if (h < 24) return `Ends in ${Math.round(h)}h`;
  const d = Math.round(h / 24);
  return `Ends in ${d} day${d === 1 ? "" : "s"}`;
}
const boxArt = (url) => (url || "").replace("{width}", "104").replace("{height}", "139").replace(/-\d+x\d+\./, "-104x139.");

// main.js supplies these once; openDropsHub() from anywhere (palette, Points & Drops) then works the same
let configured = {};
export function configureDropsHub(o) { configured = { ...configured, ...o }; }

// o: { openCategory({ id, name }), openUrl(url) }
export function openDropsHub(o = {}) {
  opts = { ...configured, ...o };
  closeDropsHub();
  data = null; query = "";
  const backdrop = el("div", "hub-backdrop");
  const panel = el("div", "hub-panel drops-panel");
  backdrop.appendChild(panel);
  const head = el("div", "hub-head");
  head.appendChild(el("div", "hub-title", "Drops"));
  const search = el("label", "hub-search");
  search.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  const input = el("input");
  input.type = "text"; input.placeholder = "Search games and rewards"; input.spellcheck = false;
  input.setAttribute("aria-label", "Search drops");
  input.value = query;
  search.appendChild(input);
  const refresh = el("button", "hub-refresh", "Refresh");
  refresh.type = "button";
  const close = el("button", "hub-close");
  close.type = "button"; close.title = "Close (Esc)";
  close.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  close.addEventListener("click", closeDropsHub);
  head.append(search, el("div", "hub-spacer"), refresh, close);
  const body = el("div", "hub-body");
  panel.append(head, body);
  input.addEventListener("input", () => { query = input.value; if (data) render(body); });
  refresh.addEventListener("click", () => load(body));
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeDropsHub(); });
  document.body.appendChild(backdrop);
  viewEl = backdrop;
  popEscape = pushEscape(closeDropsHub);
  load(body);
}

export function closeDropsHub() {
  viewEl?.remove();
  viewEl = null;
  popEscape?.();
  popEscape = null;
}

async function load(body) {
  body.replaceChildren(el("div", "hub-empty", "Loading drops…"));
  const connected = await invoke("twitch_device_connected").catch(() => false);
  if (!connected) {
    body.replaceChildren(el("div", "hub-empty", "Drops need the Twitch connection. Set it up under Settings › Twitch account."));
    return;
  }
  const [inv, all, watching] = await Promise.allSettled([
    invoke("get_drops_inventory"), invoke("get_drop_campaigns"), invoke("heartbeat_watching"),
  ]);
  if (!viewEl || !body.isConnected) return;
  data = {
    inProgress: inv.status === "fulfilled" && Array.isArray(inv.value) ? inv.value : [],
    invError: inv.status === "rejected" ? inv.reason : null,
    campaigns: all.status === "fulfilled" && Array.isArray(all.value) ? all.value : null,
    allError: all.status === "rejected" ? all.reason : null,
    watching: watching.status === "fulfilled" ? watching.value : null,
  };
  render(body);
}

// lower-cased words of the search box; a campaign matches when every word appears in its game, its name or
// one of its rewards
const words = () => query.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (texts, ws) => {
  if (!ws.length) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return ws.every((w) => hay.includes(w));
};
const ended = (c, now) => { const t = Date.parse(c.end || ""); return Number.isFinite(t) && t <= now; };

function render(body) {
  const { inProgress, invError, campaigns, allError, watching } = data;
  const ws = words(), now = Date.now();
  body.replaceChildren();
  renderInProgress(body, inProgress, invError, watching, ws, now);
  const mine = new Set(inProgress.map((c) => c.id));
  renderAvailable(body, campaigns ? campaigns.filter((c) => !mine.has(c.id)) : null, allError, ws);
}

// the campaign the stream on screen is earning: same game, still running, with a reward left to earn
function isEarning(c, watching, now) {
  if (!watching?.playing || ended(c, now)) return false;
  const sameGame = (watching.game_id && c.game_id && watching.game_id === c.game_id)
    || (watching.game_name && c.game && watching.game_name.toLowerCase() === c.game.toLowerCase());
  return !!sameGame && (c.drops || []).some((d) => !d.claimed && !d.claimable);
}

function renderInProgress(body, all, error, watching, ws, now) {
  body.appendChild(el("div", "hub-section", "In progress"));
  if (error) { body.appendChild(el("div", "hub-note error", `Couldn't load your drops (${String(error)}).`)); return; }
  // an ended campaign stays only while one of its rewards is still waiting to be claimed
  const live = all.filter((c) => !ended(c, now) || (c.drops || []).some((d) => d.claimable && !d.claimed));
  if (!live.length) { body.appendChild(el("div", "hub-note", "You aren't earning any drops right now. Watch a stream with drops enabled to start.")); return; }
  const campaigns = live
    .filter((c) => matches([c.game, c.campaign, ...(c.drops || []).map((d) => d.name)], ws))
    .map((c) => ({ c, earning: isEarning(c, watching, now) }))
    .sort((a, b) => (b.earning - a.earning) || ((Date.parse(a.c.end) || Infinity) - (Date.parse(b.c.end) || Infinity)))
    ;
  if (!campaigns.length) { body.appendChild(el("div", "hub-note", `None of your drops match "${query.trim()}".`)); return; }
  for (const { c, earning } of campaigns) {
    const card = el("div", "drops-campaign" + (earning ? " earning" : ""));
    const art = el("img", "drops-art"); art.alt = ""; art.loading = "lazy";
    if (c.box_art) art.src = boxArt(c.box_art);
    const main = el("div", "drops-main");
    const title = el("div", "drops-game", c.game || "Drops");
    const sub = el("div", "drops-campaign-name", [c.campaign, fmtEnds(c.end)].filter(Boolean).join(" · "));
    if (earning) title.appendChild(el("span", "drops-earning", watching.login ? `Earning now · ${watching.login}` : "Earning now"));
    main.append(title, sub);
    for (const d of c.drops || []) {
      const row = el("div", "drops-reward" + (d.claimed ? " claimed" : ""));
      const img = el("img", "drops-reward-img"); img.alt = ""; img.loading = "lazy";
      if (d.image) img.src = d.image;
      const info = el("div", "drops-reward-info");
      info.appendChild(el("div", "drops-reward-name", d.name || "Reward"));
      const pct = d.required ? Math.min(100, (d.current / d.required) * 100) : 0;
      const bar = el("div", "drops-bar");
      const fill = el("span"); fill.style.width = `${d.claimed || d.claimable ? 100 : pct}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
      const status = d.claimed ? "Claimed"
        : d.claimable ? "Ready to claim"
        : `${fmtLeft(d.required - d.current)} left · ${fmtLeft(d.current)} of ${fmtLeft(d.required)}`;
      info.appendChild(el("div", "drops-reward-status", status));
      row.append(img, info);
      if (d.claimable && !d.claimed) {
        const claim = el("button", "hub-btn", "Claim");
        claim.type = "button";
        claim.addEventListener("click", async () => {
          claim.disabled = true; claim.textContent = "Claiming…";
          try {
            await invoke("claim_drop", { dropInstanceId: d.drop_instance_id });
            d.claimed = true; d.claimable = false;
            row.classList.add("claimed");
            row.querySelector(".drops-reward-status").textContent = "Claimed";
            claim.remove();
          } catch (e) {
            claim.disabled = false; claim.textContent = "Claim";
            row.querySelector(".drops-reward-status").textContent = `Couldn't claim (${String(e)})`;
          }
        });
        row.appendChild(claim);
      }
      main.appendChild(row);
    }
    card.append(art, main);
    body.appendChild(card);
  }
}

function renderAvailable(body, campaigns, error, ws) {
  body.appendChild(el("div", "hub-section", "Available on Twitch"));
  if (error || !campaigns) { body.appendChild(el("div", "hub-note error", `Couldn't load the campaign list${error ? ` (${String(error)})` : ""}.`)); return; }
  const now = Date.now();
  const active = campaigns
    .filter((c) => (c.status || "ACTIVE") === "ACTIVE" && (!c.end || Date.parse(c.end) > now))
    .sort((a, b) => (Date.parse(a.end) || Infinity) - (Date.parse(b.end) || Infinity));
  if (!active.length) { body.appendChild(el("div", "hub-note", "No drop campaigns are running right now.")); return; }
  const shown = active.filter((c) => matches([c.game, c.name], ws));
  if (!shown.length) { body.appendChild(el("div", "hub-note", `No campaigns match "${query.trim()}".`)); return; }
  const grid = el("div", "drops-grid");
  for (const c of shown) {
    const card = el("div", "drops-tile");
    const art = el("img", "drops-art small"); art.alt = ""; art.loading = "lazy";
    if (c.box_art) art.src = boxArt(c.box_art);
    const main = el("div", "drops-main");
    main.append(el("div", "drops-game", c.game || "Unknown game"), el("div", "drops-campaign-name", c.name || ""));
    const meta = el("div", "drops-tile-meta", fmtEnds(c.end));
    if (!c.connected && c.link_url) meta.appendChild(el("span", "drops-unlinked", " · Account not linked"));
    main.appendChild(meta);
    const actions = el("div", "drops-tile-actions");
    const find = el("button", "hub-btn", "Find streams");
    find.type = "button";
    find.addEventListener("click", () => { closeDropsHub(); opts.openCategory?.({ id: c.game_id, name: c.game }); });
    actions.appendChild(find);
    if (!c.connected && c.link_url) {
      const link = el("button", "hub-btn", "Link account");
      link.type = "button";
      link.addEventListener("click", () => opts.openUrl?.(c.link_url));
      actions.appendChild(link);
    }
    main.appendChild(actions);
    card.append(art, main);
    grid.appendChild(card);
  }
  body.appendChild(grid);
}
