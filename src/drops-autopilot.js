// Drops autopilot (Settings > Twitch account > Drops autopilot): the stream you were earning a drops campaign on
// ended, so offer (or count down) a switch to another live stream of that game that carries the same campaign.
// main.js calls this once the end is certain (Twitch says offline and there's no Kick simulcast to fail over
// to) and never after a raid, which already moves you somewhere. helix.rs drops_autopilot_pick finds the stream.

import { invoke } from "@tauri-apps/api/core";
import { getSetting } from "./settings.js";
import { showDropsAutopilotBanner } from "./raid-banner.js";

// opts: { channel, raidedRecently(), stillOnIt(), go(login) }
export async function dropsAutopilot(opts) {
  const mode = getSetting("dropsAutopilot");
  if (mode === "off" || opts.raidedRecently?.()) return;
  const [watching, inv] = await Promise.all([
    invoke("heartbeat_watching").catch(() => null),
    invoke("get_drops_inventory").catch(() => []),
  ]);
  if (!opts.stillOnIt()) return;
  // the campaign this stream was earning: same game, not ended, with a reward still to earn by watching
  const now = Date.now();
  const game = String(watching?.game_name || "").toLowerCase();
  const campaign = (Array.isArray(inv) ? inv : []).find((c) => {
    const sameGame = (watching?.game_id && c.game_id && watching.game_id === c.game_id) || (game && String(c.game || "").toLowerCase() === game);
    const ends = Date.parse(c.end || "");
    return sameGame && !(Number.isFinite(ends) && ends <= now) && (c.drops || []).some((d) => !d.claimed && !d.claimable);
  });
  if (!campaign) return;
  let pick = null;
  try {
    pick = await invoke("drops_autopilot_pick", {
      gameId: campaign.game_id || watching?.game_id || null,
      gameName: campaign.game || watching?.game_name || null,
      campaignId: campaign.id,
      excludeLogin: opts.channel,
    });
  } catch (err) {
    console.warn("[drops-autopilot] couldn't look for another stream:", err);
    return;
  }
  if (!opts.stillOnIt()) return;
  showDropsAutopilotBanner({
    game: campaign.game || "these",
    toName: pick?.name || pick?.login || null,
    viewers: pick?.viewers || 0,
    mode,
    stillValid: opts.stillOnIt,
    go: () => pick && opts.go(pick.login),
  });
}
