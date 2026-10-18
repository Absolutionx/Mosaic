// Channel points + drops panel. Both read via GQL on the device-login token (see helix.rs), so if the
// user hasn't done the device login this offers to start it (reusing the pin-auth flow).

import { invoke } from "@tauri-apps/api/core";
import { openDropsHub, fmtLeft, fmtEnds, boxArt } from "./drops-hub.js";
import { noteKnown } from "./points-ledger.js";
import { renderLedger } from "./ledger-view.js";
import { renderWatchStats } from "./watch-stats.js";

let overlay = null;
let onRedeemedCb = null;
// what the Rewards tab last loaded, handed to the Ledger tab (balance, rewards to save for, what's playing)
let lastLoaded = null;
let ledgerCleanup = null;

function close() {
  ledgerCleanup?.(); ledgerCleanup = null;
  if (overlay) { overlay.remove(); overlay = null; }
}

// Emote picker for "Choose an Emote to Unlock" / "Modify a Single Emote" rewards. Replaces the panel body
// with a grid of the channel's unlockable emotes; picking one redeems it, then returns to the panel.
async function openEmotePicker(body, channelLogin, channelId, reward) {
  const isModified = reward.reward_type === "CHOSEN_MODIFIED_SUB_EMOTE_UNLOCK";
  body.innerHTML = `<div class="emote-picker-head">
      <button class="emote-picker-back">‹ Back</button>
      <span class="emote-picker-title">${isModified ? "Modify an emote" : "Choose an emote"} · <span class="muted">◈ ${Number(reward.cost).toLocaleString()}</span></span>
    </div><div class="rewards-emote-grid"><div class="rewards-empty">Loading emotes…</div></div>`;
  body.querySelector(".emote-picker-back").addEventListener("click", () => render(body, channelLogin, channelId));

  let emotes = [];
  try { emotes = await invoke("get_channel_emotes", { channelLogin }); } catch { /* ignore */ }
  emotes = Array.isArray(emotes) ? emotes : [];

  const tiles = [];
  if (isModified) {
    for (const e of emotes) for (const m of (e.modifications || [])) tiles.push({ id: m.id, token: m.token });
  } else {
    for (const e of emotes) tiles.push({ id: e.id, token: e.token });
  }

  const grid = body.querySelector(".rewards-emote-grid");
  if (!grid) return;
  if (!tiles.length) {
    grid.innerHTML = `<div class="rewards-empty">No unlockable emotes available on this channel.</div>`;
    return;
  }
  grid.innerHTML = "";
  for (const t of tiles) {
    const btn = document.createElement("button");
    btn.className = "emote-tile";
    btn.title = t.token || "";
    btn.innerHTML = `<img src="https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(t.id)}/default/dark/2.0" alt="${esc(t.token || "")}" loading="lazy">`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("redeeming");
      try {
        await invoke(isModified ? "unlock_modified_emote" : "unlock_chosen_emote", {
          channelLogin, emoteId: t.id, cost: reward.cost,
        });
        window.dispatchEvent(new CustomEvent("mosaic-emotes-changed", { detail: { id: t.id, token: t.token } }));
        await render(body, channelLogin, channelId, {
          text: `${isModified ? "Modified" : "Unlocked"} ${t.token}!`,
          emoteId: t.id,
        });
      } catch (e) {
        btn.disabled = false;
        btn.classList.remove("redeeming");
        btn.title = `${t.token} — ${typeof e === "string" ? e : "failed"}`;
      }
    });
    grid.appendChild(btn);
  }
}

// a reward that needs text (custom rewards with a prompt, Highlight My Message): a message box on its own
// line under the reward, with Cancel and a Redeem button that shows the cost. onSend(text, sendBtn) runs the
// redeem; the cost button comes back on Cancel
function openComposer(row, btn, { placeholder, cost, onSend }) {
  row.querySelector(".rw-composer")?.remove();
  btn.hidden = true;
  row.classList.add("rw-composing");
  const box = document.createElement("div");
  box.className = "rw-composer reward-input-wrap";
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "reward-input"; inp.placeholder = placeholder || "Your message…";
  inp.maxLength = 500;
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "rw-composer-cancel"; cancel.textContent = "Cancel";
  const send = document.createElement("button");
  send.type = "button"; send.className = "reward-redeem rw-cost-btn"; send.textContent = `Redeem ◈ ${Number(cost).toLocaleString()}`;
  send.disabled = true;
  box.append(inp, cancel, send);
  row.appendChild(box);
  inp.focus();
  inp.addEventListener("input", () => { send.disabled = !inp.value.trim(); });
  const close = () => { box.remove(); btn.hidden = false; row.classList.remove("rw-composing"); };
  cancel.addEventListener("click", close);
  const go = () => {
    if (!inp.value.trim() || send.dataset.busy) return;
    send.dataset.busy = "1"; send.disabled = true; send.textContent = "Redeeming…";
    Promise.resolve(onSend(inp.value, send)).finally(() => { delete send.dataset.busy; });
  };
  send.addEventListener("click", go);
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
    // Escape cancels the message instead of closing the whole panel
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  });
}

// one reward line in a drops card: picture, name, status on the right, progress bar under
function dropRow(d, status, pct, cls = "") {
  const img = d.image ? `<img class="rw-drop-img" src="${esc(d.image)}" alt="">` : `<span class="rw-drop-img"></span>`;
  return `<div class="rewards-drop rw-drop ${cls}">${img}<div class="rw-drop-main">
    <div class="rewards-drop-top"><span class="rewards-drop-name">${esc(d.name)}</span>${status}</div>
    <div class="rewards-bar"><div class="rewards-bar-fill${d.claimed ? " done" : ""}" style="width:${pct}%"></div></div>
  </div></div>`;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// channelLogin: current channel (for the points balance). onNeedDeviceLogin: called if not connected.
// opts: { tab: "rewards" | "ledger" | "stats", stats: { avatarFor, watch } } (main.js)
export async function openRewardsModal(channelLogin, channelId, onNeedDeviceLogin, onRedeemed, opts = {}) {
  onRedeemedCb = onRedeemed || null;
  if (overlay) close();
  overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const modal = document.createElement("div");
  modal.className = "chat-filter-modal rewards-modal rw-wide";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const onEsc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);

  header(modal, "Points & Drops");
  const body = document.createElement("div");
  body.className = "rewards-body";
  // Rewards | Ledger (ledger-view.js) | Watch stats (watch-stats.js). Watch stats is kept on this computer and
  // needs no Twitch connection; the other two show the Connect prompt without one
  const tabs = document.createElement("span");
  tabs.className = "rw-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.innerHTML = [["rewards", "Rewards"], ["ledger", "Ledger"], ["stats", "Watch stats"]]
    .map(([id, label]) => `<button type="button" class="rw-tab" data-tab="${id}" role="tab" aria-selected="false">${label}</button>`).join("");
  modal.querySelector(".chat-filter-header span")?.after(tabs);
  modal.appendChild(body);

  const connected = invoke("twitch_device_connected").then(Boolean).catch(() => false);
  let current = null;
  const show = async (tab) => {
    current = tab;
    tabs.querySelectorAll(".rw-tab").forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle("on", on); t.setAttribute("aria-selected", String(on)); });
    ledgerCleanup?.(); ledgerCleanup = null;
    if (tab === "stats") {
      const so = opts.stats || {};
      renderWatchStats(body, { avatarFor: so.avatarFor, watch: (login) => { close(); so.watch?.(login); } });
      return;
    }
    body.innerHTML = `<div class="chat-filter-intro"><span class="track-id-spinner"></span> Loading…</div>`;
    const ok = await connected;
    if (current !== tab || !body.isConnected) return;
    if (!ok) {
      body.innerHTML = `<div class="chat-filter-intro">Channel points and drops need the one-time Twitch device login (same as pinned messages).</div>`;
      const row = document.createElement("div");
      row.className = "pin-auth-actions";
      const btn = document.createElement("button");
      btn.className = "pin-auth-btn primary";
      btn.textContent = "Connect";
      btn.addEventListener("click", () => { close(); if (typeof onNeedDeviceLogin === "function") onNeedDeviceLogin(); });
      row.appendChild(btn);
      body.appendChild(row);
      return;
    }
    if (tab === "ledger") {
      let L = lastLoaded && lastLoaded.login === channelLogin ? lastLoaded : null;
      if (!L) {
        // opened without the Rewards tab first: fetch the balance and rewards (for the goal) ourselves
        const [p, r, w] = await Promise.allSettled([
          channelLogin ? invoke("get_channel_points", { channelLogin }) : Promise.resolve(null),
          channelLogin ? invoke("get_channel_rewards", { channelLogin }) : Promise.resolve([]),
          invoke("heartbeat_watching"),
        ]);
        if (current !== tab || !body.isConnected) return;
        const v = (x, f) => (x.status === "fulfilled" ? x.value : f);
        L = { login: channelLogin, points: v(p, null), rewards: (Array.isArray(v(r, [])) ? v(r, []) : []).filter((x) => x.available), watching: v(w, null)?.playing ? v(w, null).login : null };
        lastLoaded = L;
      }
      ledgerCleanup = renderLedger(body, { login: channelLogin, points: L.points, rewards: L.rewards, watching: L.watching });
    } else {
      await render(body, channelLogin, channelId);
    }
  };
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest(".rw-tab");
    if (b && !b.classList.contains("on")) show(b.dataset.tab);
  });
  await show(["rewards", "ledger", "stats"].includes(opts.tab) ? opts.tab : "rewards");
}

function header(modal, title) {
  const h = document.createElement("div");
  h.className = "chat-filter-header";
  h.innerHTML = `<span>${esc(title)}</span>`;
  const x = document.createElement("button");
  x.className = "chat-filter-close";
  x.textContent = "\u2715";
  x.addEventListener("click", close);
  h.appendChild(x);
  modal.appendChild(h);
}

async function render(body, channelLogin, channelId, flash) {
  body.innerHTML = `<div class="chat-filter-intro"><span class="track-id-spinner"></span> Loading…</div>`;
  // each part loads on its own: one that fails (a channel's points, say) shows a note in its place
  // instead of blanking the whole panel
  const settled = await Promise.allSettled([
    channelLogin ? invoke("get_channel_points", { channelLogin }) : Promise.resolve(null),
    invoke("get_drops_inventory"),
    channelLogin ? invoke("get_watch_streak", { channelLogin }) : Promise.resolve(null),
    channelLogin ? invoke("get_channel_rewards", { channelLogin }) : Promise.resolve([]),
    invoke("get_hidden_drops"),
    // which campaign the stream on screen is earning (drops-hub.js does the same); optional
    invoke("heartbeat_watching"),
  ]);
  const val = (i, fallback) => (settled[i].status === "fulfilled" ? settled[i].value : fallback);
  const errOf = (i) => (settled[i].status === "rejected" ? String(settled[i].reason) : null);
  let points = val(0, null), drops = val(1, []), streak = val(2, null), rewards = val(3, []), hidden = val(4, []);
  const watching = val(5, null);
  const pointsErr = errOf(0), dropsErr = errOf(1);
  if (!body.isConnected) return;
  drops = Array.isArray(drops) ? drops : [];
  rewards = Array.isArray(rewards) ? rewards : [];
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
  lastLoaded = { login: channelLogin, points: pointsErr ? null : points, rewards, watching: watching?.playing ? watching.login : null };

  // two columns: points (balance + rewards) on the left, drops on the right; the wide layout puts them side
  // by side like the Drops hub
  // ---- summary: balance first and large, watch streak beside it ----
  let html = `<div class="rw-cols"><div class="rw-col rw-col-points"><div class="rw-summary">`;
  if (pointsErr) {
    html += `<div class="rw-balance muted">Couldn't load your points (${esc(pointsErr)}).</div>`;
  } else if (points == null) {
    html += `<div class="rw-balance muted">${channelLogin ? "No balance for this channel." : "Open a channel to see its points."}</div>`;
  } else {
    html += `<div class="rw-balance"><span class="rw-coin">◈</span><span class="rw-balance-num">${Number(points).toLocaleString()}</span></div>
      <div class="rw-balance-sub">channel points on <b>${esc(channelLogin)}</b></div>`;
  }
  if (streak && streak.count) {
    const canShare = streak.share_status === "CAN_SHARE";
    html += `<div class="rw-chips"><span class="rw-chip"><span class="rw-chip-icon">🔥</span>${Number(streak.count).toLocaleString()} stream${streak.count === 1 ? "" : "s"} in a row</span>`;
    if (canShare) html += `<button class="rewards-claim rewards-share rw-chip-btn" data-mid="${esc(streak.milestone_id)}" data-bonus="${Number(streak.bonus || 0)}">Share +${Number(streak.bonus || 0).toLocaleString()}</button>`;
    else if (streak.share_status === "SHARED") html += `<span class="rw-chip rw-chip-ok">Shared</span>`;
    html += `</div>`;
  }
  html += `</div>`;

  // ---- rewards: what you can afford first (cheapest first), then the rest with how far off they are ----
  const redeemable = rewards.filter((r) => r.available);
  if (redeemable.length) {
    const bal = points == null ? -1 : Number(points);
    const sorted = [...redeemable].sort((a, b) => (Number(b.cost <= bal) - Number(a.cost <= bal)) || a.cost - b.cost);
    html += `<div class="rw-section">Redeem</div><div class="reward-list rw-rewards">`;
    for (const r of sorted) {
      const afford = bal >= r.cost;
      const img = r.image
        ? `<img class="reward-img" src="${esc(r.image)}" alt="">`
        : `<span class="reward-img reward-img-fallback">◈</span>`;
      const cost = Number(r.cost).toLocaleString();
      html += `<div class="reward-row${afford ? "" : " rw-locked"}" data-id="${esc(r.id)}" data-cost="${r.cost}" data-title="${esc(r.title)}" data-input="${r.requires_input ? 1 : 0}" data-prompt="${esc(r.prompt)}">
        ${img}
        <span class="reward-title">${esc(r.title)}</span>`;
      if (afford) {
        html += `<button class="reward-redeem rw-cost-btn" title="Redeem for ${cost} points">◈ ${cost}</button>`;
      } else if (bal < 0) {
        // balance unknown (it didn't load): just the cost, not "N more"
        html += `<span class="rw-need"><span class="rw-need-text">◈ ${cost}</span></span>`;
      } else {
        const pct = bal > 0 ? Math.min(100, Math.round((bal / r.cost) * 100)) : 0;
        html += `<span class="rw-need" title="${cost} points"><span class="rw-need-text">${(r.cost - Math.max(0, bal)).toLocaleString()} more</span>
          <span class="rw-need-bar"><span style="width:${pct}%"></span></span></span>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // ---- drops: one card per campaign, the one this stream is earning first ----
  html += `</div><div class="rw-col rw-col-drops"><div class="rw-section rewards-drops-title">Drops <button type="button" class="rewards-drops-hub">Open drops hub</button></div>`;
  const visibleDrops = drops.filter((c) => !hiddenSet.has(c.id));
  const hiddenDrops = drops.filter((c) => hiddenSet.has(c.id));
  const earning = (c) => !!watching?.playing && (
    (watching.game_id && c.game_id && watching.game_id === c.game_id)
    || (watching.game_name && c.game && watching.game_name.toLowerCase() === String(c.game).toLowerCase()));
  if (dropsErr) {
    html += `<div class="rewards-empty">Couldn't load your drops (${esc(dropsErr)}).</div>`;
  } else if (!visibleDrops.length && !hiddenDrops.length) {
    html += `<div class="rewards-empty">No active drops. Progress accrues while you watch a drops-enabled stream.</div>`;
  } else {
    html += `<div class="rw-camps">`;
    const cards = visibleDrops.map((c) => ({ c, earn: earning(c), claimable: (c.drops || []).some((d) => d.claimable && !d.claimed) }))
      .sort((a, b) => (b.claimable - a.claimable) || (b.earn - a.earn));
    for (const { c, earn } of cards) {
      const all = c.drops || [];
      const left = all.filter((d) => !d.claimed);
      const ready = left.filter((d) => d.claimable);
      // the next reward: the unclaimed one closest to done
      const next = left.filter((d) => !d.claimable).sort((a, b) => (a.required - a.current) - (b.required - b.current))[0];
      const done = all.filter((d) => d.claimed).length;
      const meta = [c.campaign, fmtEnds(c.end)].filter(Boolean).map(esc).join(" · ");
      html += `<div class="rewards-campaign rw-camp${earn ? " earning" : ""}">
        <div class="rw-camp-head">
          ${c.box_art ? `<img class="rw-camp-art" src="${esc(boxArt(c.box_art))}" alt="">` : `<span class="rw-camp-art"></span>`}
          <div class="rw-camp-info">
            <div class="rw-camp-game">${esc(c.game || "Drops")}${earn ? `<span class="rw-earning">Earning now</span>` : ""}</div>
            <div class="rw-camp-meta">${meta}</div>
          </div>
          <span class="rw-camp-count" title="Rewards claimed">${done}/${all.length}</span>
          <button class="rewards-drop-hide" data-cid="${esc(c.id)}" title="Hide these drops">×</button>
        </div>`;
      // rewards ready to claim come first, each with its own button
      for (const d of ready) html += dropRow(d, `<button class="rewards-claim" data-id="${esc(d.drop_instance_id)}">Claim</button>`, 100);
      if (next) {
        const pct = next.required > 0 ? Math.min(100, Math.round((next.current / next.required) * 100)) : 0;
        html += dropRow(next, `<span class="rw-left">${fmtLeft(next.required - next.current)} left</span>`, pct, "rw-next");
      }
      // everything else, folded away
      const rest = all.filter((d) => d !== next && !ready.includes(d));
      if (rest.length) {
        // the extra rewards open ABOVE the toggle, so the toggle stays at the bottom of the card
        html += `<div class="rw-more-list" hidden>`;
        for (const d of rest) {
          const pct = d.claimed ? 100 : d.required > 0 ? Math.min(100, Math.round((d.current / d.required) * 100)) : 0;
          const status = d.claimed ? `<span class="rewards-claimed">Claimed</span>` : `<span class="rw-left">${fmtLeft(d.required - d.current)} left</span>`;
          html += dropRow(d, status, pct, d.claimed ? "rw-claimed" : "");
        }
        html += `</div><button type="button" class="rw-more-btn" data-more="${rest.length} more reward${rest.length === 1 ? "" : "s"}" aria-expanded="false">
          <span class="rw-more-label">${rest.length} more reward${rest.length === 1 ? "" : "s"}</span>
          <svg class="rw-more-chev" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>`;
      }
      html += `</div>`;
    }
    html += `</div>`; // .rw-camps
    if (!visibleDrops.length) {
      html += `<div class="rewards-empty">All drops hidden.</div>`;
    }
    if (hiddenDrops.length) {
      html += `<div class="rewards-hidden-wrap"><button class="rewards-hidden-toggle" data-open="0">Hidden (${hiddenDrops.length}) · show</button><div class="rewards-hidden-list" hidden>`;
      for (const c of hiddenDrops) {
        html += `<div class="rewards-hidden-row"><span class="muted">${esc(c.game)}${c.campaign ? ` · ${esc(c.campaign)}` : ""}</span><button class="rewards-drop-restore" data-cid="${esc(c.id)}">Restore</button></div>`;
      }
      html += `</div></div>`;
    }
  }
  html += `</div></div>`; // .rw-col-drops, .rw-cols
  body.innerHTML = html;
  body.querySelector(".rewards-drops-hub")?.addEventListener("click", () => { close(); openDropsHub(); });
  body.querySelectorAll(".rw-more-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = btn.previousElementSibling;
      const open = btn.getAttribute("aria-expanded") !== "true";
      list.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      btn.querySelector(".rw-more-label").textContent = open ? "Show less" : btn.dataset.more;
    });
  });

  if (flash) {
    const banner = document.createElement("div");
    banner.className = "rewards-flash";
    if (flash.emoteId) {
      const img = document.createElement("img");
      img.className = "rewards-flash-emote";
      img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(flash.emoteId)}/default/dark/2.0`;
      img.alt = "";
      banner.appendChild(img);
    }
    banner.appendChild(document.createTextNode(flash.text));
    body.insertBefore(banner, body.firstChild);
    // fade + fold away (styles.css), then take it out of the panel entirely
    setTimeout(() => banner.classList.add("fade"), 4000);
    setTimeout(() => banner.remove(), 5000);
  }

  const rewardById = new Map(redeemable.map((r) => [String(r.id), r]));
  const DEFERRED = new Set([
    "SINGLE_MESSAGE_BYPASS_SUB_MODE",
    "SEND_GIGANTIFIED_EMOTE",
  ]);
  const EMOTE_PICKER = new Set([
    "CHOSEN_SUB_EMOTE_UNLOCK",
    "CHOSEN_MODIFIED_SUB_EMOTE_UNLOCK",
  ]);
  body.querySelectorAll(".reward-redeem").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".reward-row");
      if (!row) return;
      const r = rewardById.get(row.getAttribute("data-id"));
      if (!r) return;
      const finish = async () => {
        try { noteKnown(channelLogin, -Number(r.cost || 0), "spend", r.title); } catch { /* ignore */ }
        if (onRedeemedCb) onRedeemedCb(r.title, r.cost);
        await render(body, channelLogin, channelId);
      };
      const fail = (e, b) => {
        b.disabled = false;
        b.textContent = "Retry";
        b.title = typeof e === "string" ? e : "Failed";
      };

      if (r.automatic) {
        if (r.reward_type === "RANDOM_SUB_EMOTE_UNLOCK") {
          btn.disabled = true; btn.textContent = "…";
          try {
            const em = await invoke("redeem_random_emote", { channelLogin, cost: r.cost });
            window.dispatchEvent(new CustomEvent("mosaic-emotes-changed",
              em && em.id ? { detail: { id: em.id, token: em.token } } : undefined));
            await render(body, channelLogin, channelId,
              em && em.id ? { text: `Unlocked ${em.token}!`, emoteId: em.id } : { text: "Emote unlocked!" });
          }
          catch (e) { fail(e, btn); }
        } else if (r.reward_type === "SEND_HIGHLIGHTED_MESSAGE") {
          openComposer(row, btn, { placeholder: "Message to highlight in chat…", cost: r.cost, onSend: async (text, send) => {
            try { await invoke("redeem_highlight_message", { channelLogin, message: text, cost: r.cost }); await finish(); }
            catch (e) { fail(e, send); }
          } });
        } else if (EMOTE_PICKER.has(r.reward_type)) {
          openEmotePicker(body, channelLogin, channelId, r);
        } else if (DEFERRED.has(r.reward_type)) {
          const old = btn.textContent;
          btn.textContent = "On Twitch";
          btn.title = "This reward needs an emote picker — redeem it on Twitch for now";
          setTimeout(() => { btn.textContent = old; }, 1600);
        } else {
          btn.title = "Not supported in Mosaic yet";
        }
        return;
      }

      // custom reward: `prompt` is the viewer's INPUT — empty when the reward doesn't require input,
      // the typed text when it does. (Sending the reward's description here causes PROPERTIES_MISMATCH.)
      if (r.requires_input) {
        openComposer(row, btn, { placeholder: r.prompt || "Your message…", cost: r.cost, onSend: async (text, send) => {
          try { await invoke("redeem_reward", { channelLogin, rewardId: r.id, cost: r.cost, title: r.title, prompt: text }); await finish(); }
          catch (e) { fail(e, send); }
        } });
        return;
      }
      btn.disabled = true; btn.textContent = "…";
      try {
        await invoke("redeem_reward", { channelLogin, rewardId: r.id, cost: r.cost, title: r.title, prompt: "" });
        await finish();
      } catch (e) { fail(e, btn); }
    });
  });
  body.querySelectorAll(".rewards-drop-hide").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("set_drop_hidden", { campaignId: btn.getAttribute("data-cid"), hidden: true });
        await render(body, channelLogin, channelId);
      } catch { btn.disabled = false; }
    });
  });
  body.querySelectorAll(".rewards-drop-restore").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await invoke("set_drop_hidden", { campaignId: btn.getAttribute("data-cid"), hidden: false });
        await render(body, channelLogin, channelId);
      } catch { btn.disabled = false; }
    });
  });
  body.querySelectorAll(".rewards-hidden-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = btn.nextElementSibling;
      const open = btn.getAttribute("data-open") === "1";
      btn.setAttribute("data-open", open ? "0" : "1");
      if (list) list.hidden = open;
      btn.textContent = btn.textContent.replace(open ? "hide" : "show", open ? "show" : "hide");
    });
  });
  body.querySelectorAll(".rewards-claim:not(.rewards-share)").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      btn.disabled = true;
      btn.textContent = "Claiming…";
      try {
        await invoke("claim_drop", { dropInstanceId: id });
        await render(body, channelLogin, channelId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Retry";
        btn.title = `Couldn't claim: ${String(err)}`; // Twitch's reason (e.g. the claim window closed)
      }
    });
  });
  body.querySelectorAll(".rewards-share").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mid = btn.getAttribute("data-mid");
      btn.disabled = true;
      btn.textContent = "Sharing…";
      try {
        await invoke("share_watch_streak", { channelLogin, milestoneId: mid });
        try { noteKnown(channelLogin, Number(btn.getAttribute("data-bonus")) || 0, "streak", "Shared watch streak"); } catch { /* ignore */ }
        await render(body, channelLogin, channelId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    });
  });
}
