// Channel points + drops panel. Both read via GQL on the device-login token (see helix.rs), so if the
// user hasn't done the device login this offers to start it (reusing the pin-auth flow).

import { invoke } from "@tauri-apps/api/core";

let overlay = null;
let onRedeemedCb = null;

function close() {
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

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// channelLogin: current channel (for the points balance). onNeedDeviceLogin: called if not connected.
export async function openRewardsModal(channelLogin, channelId, onNeedDeviceLogin, onRedeemed) {
  onRedeemedCb = onRedeemed || null;
  if (overlay) close();
  overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const modal = document.createElement("div");
  modal.className = "chat-filter-modal rewards-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  const onEsc = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } };
  document.addEventListener("keydown", onEsc);

  header(modal, "Points & Drops");
  const body = document.createElement("div");
  body.className = "rewards-body";
  body.innerHTML = `<div class="chat-filter-intro"><span class="track-id-spinner"></span> Loading…</div>`;
  modal.appendChild(body);

  let connected = false;
  try { connected = await invoke("twitch_device_connected"); } catch {}
  if (!connected) {
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

  await render(body, channelLogin, channelId);
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
  let points = null, drops = [], streak = null, rewards = [], hidden = [];
  try { [points, drops, streak, rewards, hidden] = await Promise.all([
    channelLogin ? invoke("get_channel_points", { channelLogin }) : Promise.resolve(null),
    invoke("get_drops_inventory"),
    channelLogin ? invoke("get_watch_streak", { channelLogin }) : Promise.resolve(null),
    channelLogin ? invoke("get_channel_rewards", { channelLogin }) : Promise.resolve([]),
    invoke("get_hidden_drops"),
  ]); } catch (err) {
    body.innerHTML = `<div class="chat-filter-intro">Couldn't load: ${esc(err)}</div>`;
    return;
  }
  drops = Array.isArray(drops) ? drops : [];
  rewards = Array.isArray(rewards) ? rewards : [];
  const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);

  let html = `<div class="rewards-section-title">Channel Points</div>`;
  if (points == null) {
    html += `<div class="rewards-points muted">${channelLogin ? "No balance for this channel." : "Open a channel to see its points."}</div>`;
  } else {
    html += `<div class="rewards-points"><span class="rewards-coin">◈</span> ${Number(points).toLocaleString()} <span class="muted">on ${esc(channelLogin)}</span></div>`;
  }

  const redeemable = rewards.filter((r) => r.available);
  if (redeemable.length) {
    html += `<div class="rewards-section-title">Redeem</div><div class="reward-list">`;
    for (const r of redeemable) {
      const afford = points != null && points >= r.cost;
      const disabled = !afford;
      const img = r.image
        ? `<img class="reward-img" src="${esc(r.image)}" alt="">`
        : `<span class="reward-img reward-img-fallback">◈</span>`;
      const tip = !afford ? "Not enough points" : "";
      html += `<div class="reward-row" data-id="${esc(r.id)}" data-cost="${r.cost}" data-title="${esc(r.title)}" data-input="${r.requires_input ? 1 : 0}" data-prompt="${esc(r.prompt)}">
        ${img}
        <span class="reward-title">${esc(r.title)}</span>
        <span class="reward-cost">◈ ${Number(r.cost).toLocaleString()}</span>
        <button class="reward-redeem"${disabled ? " disabled" : ""}${tip ? ` title="${esc(tip)}"` : ""}>Redeem</button>
      </div>`;
    }
    html += `</div>`;
  }

  if (streak && streak.count) {
    const canShare = streak.share_status === "CAN_SHARE";
    const shareBtn = canShare
      ? `<button class="rewards-claim rewards-share" data-mid="${esc(streak.milestone_id)}">Share +${Number(streak.bonus || 0).toLocaleString()}</button>`
      : (streak.share_status === "SHARED" ? `<span class="rewards-claimed">Shared</span>` : "");
    html += `<div class="rewards-section-title">Watch Streak</div>
      <div class="rewards-streak"><span class="rewards-streak-flame">🔥</span> <b>${Number(streak.count).toLocaleString()}</b> <span class="muted">stream${streak.count === 1 ? "" : "s"} in a row</span> ${shareBtn}</div>`;
  }

  html += `<div class="rewards-section-title">Drops</div>`;
  const visibleDrops = drops.filter((c) => !hiddenSet.has(c.id));
  const hiddenDrops = drops.filter((c) => hiddenSet.has(c.id));
  if (!visibleDrops.length && !hiddenDrops.length) {
    html += `<div class="rewards-empty">No active drops. Progress accrues while you watch a drops-enabled stream.</div>`;
  } else {
    for (const c of visibleDrops) {
      html += `<div class="rewards-campaign"><div class="rewards-campaign-head">
        <span class="rewards-campaign-title">${esc(c.game)}${c.campaign ? ` · <span class="muted">${esc(c.campaign)}</span>` : ""}</span>
        <button class="rewards-drop-hide" data-cid="${esc(c.id)}" title="Hide these drops">×</button>
      </div>`;
      for (const d of c.drops) {
        const pct = d.required > 0 ? Math.min(100, Math.round((d.current / d.required) * 100)) : (d.claimed || d.claimable ? 100 : 0);
        const status = d.claimed ? `<span class="rewards-claimed">Claimed</span>`
          : d.claimable ? `<button class="rewards-claim" data-id="${esc(d.drop_instance_id)}">Claim</button>`
          : `<span class="muted">${d.current}/${d.required} min</span>`;
        html += `<div class="rewards-drop">
          <div class="rewards-drop-top"><span class="rewards-drop-name">${esc(d.name)}</span>${status}</div>
          <div class="rewards-bar"><div class="rewards-bar-fill${d.claimed ? " done" : ""}" style="width:${pct}%"></div></div>
        </div>`;
      }
      html += `</div>`;
    }
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
  body.innerHTML = html;

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
    setTimeout(() => banner.classList.add("fade"), 4000);
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
          const wrap = document.createElement("span");
          wrap.className = "reward-input-wrap";
          const inp = document.createElement("input");
          inp.type = "text"; inp.className = "reward-input"; inp.placeholder = "Message to highlight…";
          const send = document.createElement("button");
          send.className = "reward-redeem"; send.textContent = "Send";
          wrap.appendChild(inp); wrap.appendChild(send);
          btn.replaceWith(wrap); inp.focus();
          const go = async () => {
            if (!inp.value.trim()) return;
            send.disabled = true; send.textContent = "…";
            try { await invoke("redeem_highlight_message", { channelLogin, message: inp.value, cost: r.cost }); await finish(); }
            catch (e) { fail(e, send); }
          };
          send.addEventListener("click", go);
          inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
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
        const wrap = document.createElement("span");
        wrap.className = "reward-input-wrap";
        const inp = document.createElement("input");
        inp.type = "text"; inp.className = "reward-input"; inp.placeholder = r.prompt || "Your message…";
        const send = document.createElement("button");
        send.className = "reward-redeem"; send.textContent = "Send";
        wrap.appendChild(inp); wrap.appendChild(send);
        btn.replaceWith(wrap); inp.focus();
        const go = async () => {
          if (!inp.value.trim()) return;
          send.disabled = true; send.textContent = "…";
          try { await invoke("redeem_reward", { channelLogin, rewardId: r.id, cost: r.cost, title: r.title, prompt: inp.value }); await finish(); }
          catch (e) { fail(e, send); }
        };
        send.addEventListener("click", go);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
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
        await render(body, channelLogin, channelId);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    });
  });
}
