<p align="center">
  <img src="assets/mosaic-banner.png" alt="Mosaic, a native desktop client for Twitch and Kick" width="760">
</p>

A lightweight native desktop client for watching **Twitch and Kick** streams
and VODs, built with [Tauri](https://tauri.app) (Rust) + vanilla JS. It gives
you the whole viewing experience, full chat, multi-stream viewing,
Picture-in-Picture, live seeking, VODs, at a fraction of a browser tab's
memory, with no ads SDK and no browser chrome.

> **Status:** independent hobby project, not affiliated with or endorsed by
> Twitch Interactive, Inc. or Kick.

## Features

### Watching

- **Twitch and Kick in one app.** A toggle in the header switches the entire app between the two platforms, so the home feed,
  browse, search, sidebar, and the watch box all follow (Twitch is the default; Kick mode turns the accent green).
- **Ad-stripped playback** on Twitch via streamlink, with the stream played
  through a native pipeline rather than the web player.
- **Quality selection with adaptive auto mode**, steps quality down on
  sustained buffering and back up when the network recovers.
- **Low-latency mode** and **catch-up to live** for Twitch live.
- **Live-DVR seeking.** Seek backward on a live stream: within a rolling buffer
  instantly, and further back against the in-progress recording if the
  broadcaster has VODs enabled.
- **VODs** with a full seek bar, chapter markers, hover seek-preview
  thumbnails, a chat-activity heatmap, top-clip markers,
  copyright-muted-segment markers, and resume-where-you-left-off.
- **VOD playback speed** from 0.5x to 2x, with pitch preserved.
- **VOD bookmarks.** Mark a moment with an optional note (`B`); bookmarks show
  on the seek bar and are listed per VOD and across all VODs.
- **VOD downloads.** Save a whole VOD, or a time range of it, to MP4 (or M4A for
  audio only). The stream is copied without re-encoding.
- **VOD chat replay**, Twitch VOD comments replayed in sync with playback.
- **Clips.** Create a clip from the live stream (choose a length and title, or
  `Alt+X` for an instant clip), follow its progress, then play, copy, share or
  edit it. Clip links in chat open in an in-app clip player, and channel pages
  have a Clips tab.
- **MultiView**, watch several streams at once in a grid, with drag-to-reorder,
  per-tile or single-focus audio, spotlight and split layouts, and per-tile
  pop-out to Picture-in-Picture.
- **Picture-in-Picture**, a floating always-on-top mini player (with fallbacks
  to Document PiP and the browser's native PiP), optional auto-PiP when you tab
  away, and a rescue control for a PiP window stranded on a disconnected monitor.
- **Twitch → Kick failover.** If a Twitch stream ends mid-watch and the streamer
  is simulcasting on Kick, playback hands over to the Kick stream automatically.
  Channel-name mismatches are handled with per-channel Kick aliases.
- **Chat overlay** (optional) in theater mode and fullscreen: chat drawn over the
  video picture, movable and resizable, with the regular chat box available for
  typing.
- **Audio normalization** (optional) that evens out loud and quiet moments, in
  three strengths.
- **Stats for nerds** from the player's right-click menu: resolution, frame rate,
  codecs, bitrate, buffer, latency and dropped frames.
- **Raid banner.** When the channel you're watching raids out, follow
  automatically after a countdown, get asked, or ignore it.
- **Theater mode, header/chat collapse, fullscreen, and keyboard shortcuts**
  (see [Keyboard shortcuts](#keyboard-shortcuts)). The window opens maximized.
- **Session restore**, an app reload/restart resumes what you were watching.

### Chat

- **Full Twitch chat** with send, replies, and a message history.
- **Emotes from every source**, Twitch (global, channel, and your own
  subscriber / follower / unlocked / modified emotes), 7TV, BTTV, and FFZ,
  including animated and **zero-width overlay** emotes, plus cheermotes.
- **Badges** (global and per-channel), with automatic contrast-lightening so
  hard-to-read name colors stay legible on the dark background.
- **Moderation toolkit** (shown only when you're a mod/broadcaster): per-message
  hover actions (delete, timeout with a duration menu, ban), a user card with
  timeout presets and ban, and slash commands. A **shield menu** exposes room
  controls, emote-only, followers-only (with minimum follow time), subscriber-only,
  slow mode, unique-chat (r9k), and clear chat.
- **Mod action log**, a live, colour-coded feed of bans, timeouts, and deletions
  on any channel (with richer "who did what" detail on channels you moderate),
  plus a **Mod Chat** tab that filters chat down to just moderators and the
  broadcaster.
- **AutoMod hold queue**, review, allow, or deny held messages inline.
- **User cards**, avatar, account age, this session's message log, and mod
  actions, opened by clicking a username.
- **Link previews** on hover, **@mention autocomplete**, an **emote picker**,
  and first-time-chatter / mention highlighting.
- **Emote cards on hover**, a larger preview with the emote's source (7TV, BTTV,
  FFZ, Twitch, Kick), creator, and notes for renamed or zero-width emotes.
- **Predictions and polls**, shown as live cards with odds and payouts; bet
  channel points and vote from the app, with results posted to chat.
- **Chat badge picker**, change your global or channel badge.
- **Chat filter**, hide messages by word, user or emote; ASCII art is detected and
  laid out to fit.
- **Whispers**, with local history.
- **Message right-click menu**: reply, copy, view profile, and mod actions.
- **Kick chat**, read live Kick chat (with Kick's native emotes and badges);
  sending requires an optional Kick login (see [Kick support](#kick-support)).

### Rewards

These use a one-time Twitch **device login** (separate from the main login, done
in-app the first time you use them).

- **Channel points**, see your balance and **spend it**. Redeem the channel's
  custom rewards (with a text box where the reward requires input) and Twitch's
  built-in rewards, Highlight My Message, Unlock a Random Sub Emote (with a reveal
  of what you got), and an in-app emote picker for Choose / Modify an Emote.
- **Real-time redemptions**, a PubSub connection surfaces redemptions in chat as
  they happen (yours and other viewers') and keeps your balance live.
- **Channel points bonus auto-claim** (on by default), the bonus chest is claimed
  within about a minute of appearing.
- **Drops hub** (the **Drops** tab in the header), every campaign you're earning
  with per-reward progress and claiming, plus all active campaigns on Twitch with
  "Find streams" and account-linking shortcuts. Drops are claimed automatically
  when ready (on by default), and campaigns you don't care about can be hidden.
- **Watch streaks**, shown per channel, with one-click share for the bonus.
- **Song ID**, identify the track currently playing through a built-in
  fingerprinter (no external service or API key).

### Discovery

- **Home feed**, a carousel plus recommended and per-category rows.
- **Browse / directory**, category pills, a Categories/Live switcher, search,
  and sort.
- **Followed channels sidebar**, live and offline, plus a public Live Channels
  rail that needs no login.
- **Go-live notifications**, opt in per channel and get a system notification
  when they start streaming.
- **Command palette** (`Ctrl+K`), jump to any channel, category, setting, action
  or in-progress VOD from the keyboard.
- **Follow and unfollow** from the channel info bar.

### Quality of life

- **In-app auto-update** on Windows, a compact **Update** button appears in the
  header when a new version is available, one click to download and install.
- **Dependency bootstrap**, an in-app banner can install streamlink/ffmpeg for
  you on Windows.
- **Settings panel** (`Ctrl+,`), every option in one searchable place, with
  backup and restore of settings and local data.
- **You and this channel**, the Subscribe button on a Twitch channel opens a
  read-only panel: your subscription (months, tier, Prime or gift, renewal or end
  date), how long you've followed, the messages you've sent from Mosaic, your
  watch time, channel points and watch streak, with a link to subscribe or manage
  on Twitch. The button reads "Subscribed" when you are. Mosaic never buys or
  changes a subscription. Tier and renewal details use the Twitch device login.
- **Subscription ending reminders**, a desktop notification before a Twitch
  subscription that won't renew runs out (gifted, Prime or cancelled): once a
  chosen number of days ahead and once on the last day, for any channel, not just
  the one you're watching. The panel shows the end date and days left, and the
  Subscribe button gets a dot when the end is near.
- **Watch stats**, time watched by day, week and month, top channels, live vs VOD
  and your streak. Stored locally.
- **Start with your computer**, optionally minimized to the tray.
- **System tray**, close to tray, a **watch heartbeat** that accrues Drops and
  channel points while you watch, and a WebView2 sleep/wake surface-recovery fix.
  The window keeps its monitor and size when displays sleep.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward (step set in Settings) |
| `<` / `>` | VOD playback speed down / up |
| `T` | Theater mode |
| `F` | Fullscreen |
| `M` | Mute |
| `B` | Bookmark the current moment (VODs) |
| `Alt+X` | Create a clip (live) |
| `Ctrl+K` | Command palette |
| `Ctrl+,` | Settings |
| `Esc` | Close the top panel, or leave theater mode / fullscreen |

Shortcuts are ignored while typing in a text field.

## Download and install

The easiest way to get the app is a prebuilt installer from the
[Releases](../../releases) page, no build tools required.

- **Windows:** download the `_x64-setup.exe` from the latest release and run it.
  It's a standard per-user installer (no admin prompt). After the first install,
  the app **updates itself**: when a new release is published, an "Update
  available" banner appears on launch, and one click downloads and installs it
  without leaving the app.
- **macOS:** download the `.dmg` (Apple Silicon = `aarch64`, older Intel Macs =
  `x86_64`) from the latest release. Because the build is unsigned, the first
  launch needs **right-click → Open** once (or System Settings → Privacy &
  Security → "Open Anyway"); after that it opens normally.

Either way, you also need streamlink and ffmpeg installed (see
[Runtime requirements](#runtime-requirements)).

### Runtime requirements

The app shells out to two tools to play video. Install both before use:

- **Windows:** the app can bootstrap these for you via the in-app dependency
  banner, or install them manually.
- **macOS:** `brew install streamlink ffmpeg`
- **Linux:** install `streamlink` and `ffmpeg` from your distro's package
  manager. (See the platform-support note under [Known limitations](#known-limitations)
  - Linux is untested.)

On macOS, a Finder-launched app doesn't inherit your shell's `PATH`, so the app
looks for streamlink/ffmpeg in the usual Homebrew locations (`/opt/homebrew/bin`,
`/usr/local/bin`) automatically.

## How playback works

Playback takes a different path per platform, for good reasons:

- **Windows** pulls the stream with streamlink, relays the raw bytes over a local
  HTTP server, and feeds them to a `<video>` element via the
  [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
  API. This keeps streamlink in the loop to actively strip mid-stream ads.
- **macOS** resolves an ad-free HLS playlist URL with streamlink, routes it
  through a local CORS proxy, and lets WebKit play it as **native HLS**. This is
  because WebKit's Media Source Extensions implementation is unreliable for this
  use case, whereas native HLS is hardware-accelerated and robust. (A tradeoff:
  streamlink isn't kept in-loop to splice dynamically-stitched mid-stream ads on
  this path, so some may occasionally leak where the Windows path would catch
  them.)
- **VODs** on all platforms, and **Kick** on Windows, play through hls.js /
  native HLS. (Kick on macOS is untested, see the platform note below.)

## Known limitations

- **Drops, channel points (including the bonus auto-claim and betting),
  predictions, polls, badges, and real-time redemptions rely on reverse-engineered
  Twitch mechanisms**, not official APIs. Accrual is driven by a "minute watched"
  heartbeat, and live redemptions/balance use Twitch's (now deprecated) PubSub.
  Both work reliably in testing, but because they aren't officially supported they
  could break if Twitch changes their backend. These features also need the
  one-time in-app **device login**.
- **Live seeking is limited to a rolling ~2 minute buffer** unless the streamer
  has VODs enabled, in which case seeking further back transparently switches to
  hls.js against the in-progress VOD (see the comments above
  `seekToClickPosition` in `src/playback-controls.js`). There's an unavoidable
  few-seconds delay the first time you do this per session, since it involves
  resolving a CDN URL; subsequent seeks reuse a cached URL and are much faster.
- **Platform support:** the app has had the most real-world testing on Windows,
  followed by macOS. **Linux is fully untested**. It's targeted by the build
  scripts and may build, but nothing on it has been verified. **Kick on macOS is
  also untested** and may not work. Treat both as unsupported for now.

## Building from source

You only need this if you want to develop or build the app yourself. Most people
should use a prebuilt installer from [Releases](../../releases).

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Platform build tools: **Windows**, Microsoft C++ Build Tools + WebView2
  runtime; **macOS**, Xcode Command Line Tools; **Linux**, `webkit2gtk`,
  `libssl`, `librsvg2`, and friends.
- [streamlink](https://streamlink.github.io/install.html) and `ffmpeg`
  (runtime dependencies, see above)

The bootstrap scripts (`build-unix.sh`, `build-windows.ps1`) install all of the
above for you and then build. Run `build-windows.ps1` from an elevated
PowerShell, or `./build-unix.sh` on macOS/Linux.

### Develop

```bash
npm install
npm run tauri dev
```

This launches the app with the frontend hot-reloading.

### Build an installer

```bash
npm run tauri build
```

Add `-- --bundles nsis` to build only the Windows `.exe` installer. Output lands
under `src-tauri/target/release/bundle/` (e.g. `nsis/Mosaic_<version>_x64-setup.exe`,
`dmg/Mosaic_<version>_aarch64.dmg`).

> **Note:** `createUpdaterArtifacts` is enabled, so `tauri build` requires the
> updater signing key. For a plain local build without signing, use
> `npm run tauri dev`, or set the `TAURI_SIGNING_PRIVATE_KEY` /
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` environment variables. See
> [UPDATER_SETUP.md](./UPDATER_SETUP.md).

### Releases and auto-updates (maintainers)

Releases are built and published by GitHub Actions. Notable changes per version
are listed in [CHANGELOG.md](./CHANGELOG.md).

- Pushing a `v*` tag (or publishing a release with that tag) triggers the Windows
  workflow, which builds and signs the installer and attaches it, plus the
  `latest.json` the auto-updater checks, to the release.
- The macOS workflow is manual (run it from the Actions tab when a macOS build is
  needed).

The Windows auto-updater requires a signing keypair; setup is documented in
[UPDATER_SETUP.md](./UPDATER_SETUP.md). The app checks the latest release's
`latest.json` on startup and offers the update in-app.

### Logging in

Login uses Twitch's standard OAuth implicit-grant flow via your system's default
browser (not an embedded webview, see the comment block at the top of
`src-tauri/src/oauth.rs` for why). No client secret is involved; the `CLIENT_ID`
values in this repo are public identifiers, not credentials, and are safe to keep
in source control. If you fork this project for real-world use, you may want to
[register your own Twitch application](https://dev.twitch.tv/console/apps) and
swap in your own client ID.

## Project structure

```
src/                    Frontend (vanilla JS, no framework)
  main.js               App entry point / state orchestration
  session.js            Shared "what's playing" state
  platform.js           Twitch/Kick mode + command routing
  settings.js           Settings store (defaults, persistence, change events)
  settings-panel.js     Settings panel UI
  backup.js             Settings / local data export and import
  command-palette.js    Ctrl+K palette
  escape-stack.js       Escape closes the top-most panel
  stream-player.js      MSE feeder for the live relay (Windows path)
  vod-player.js         hls.js / native-HLS wrapper (VODs, Kick, macOS live)
  playback-controls.js  Seek bar, quality/speed menus, live-DVR handoff, PiP
  player-stats.js       Player right-click menu + Stats for nerds
  audio-normalizer.js   Optional compressor / make-up gain / limiter
  pip.js, mini-player.js  Always-on-top PiP window, in-app mini player
  multiview.js          Multi-stream grid
  channel-info-bar.js   Below-player info strip, follow button, overlay
  channel-you.js        Subscribe button panel: your sub, follow age, stats
  sub-expiry.js         Reminders before a subscription runs out
  layout.js             Page switching, theater/fullscreen, chrome
  titlebar.js           Custom window controls
  raid-banner.js        Raid countdown banner
  clips.js              Clip creation panel + progress card
  vod-downloads.js      VOD download dialog + downloads panel
  vod-bookmarks.js      VOD bookmarks (seek-bar markers, lists)
  vod-heatmap.js        VOD chat-activity heatmap
  chat.js               Chat connection lifecycle + message pipeline
  chat-overlay.js       Chat over the video in theater mode / fullscreen
  chat-filter.js        Word / user / emote filter
  emote-card.js         Emote hover cards
  whispers.js           Whispers panel + local history
  chat/                 Chat feature mixins (see file header comments):
                          chat-emotes.js, emote-parsing.js, chat-badges.js,
                          chat-badge-picker.js, kick-badges.js,
                          chat-events.js, chat-live-events.js (predictions,
                          polls), chat-automod.js, chat-usercard.js,
                          chat-mod-actions.js, chat-link-preview.js,
                          chat-clips.js, chat-autocomplete.js,
                          chat-emote-picker.js, chat-vod-replay.js, shared.js
  home.js, browse.js, vods.js, sidebar.js   Discovery UI
  hidden-channels.js    Channels hidden from the feeds
  hype-badges.js        Hype-train indicators in channel lists
  auth.js               Twitch login (frontend)
  kick-aliases.js       Twitch->Kick failover aliases
  kick-follows.js       Local Kick follow list
  chapters.js           Twitch VOD chapter markers
  seek-thumbnails.js    VOD storyboard seek-preview thumbnails
  session-restore.js    Resume the last session across a reload
  drops.js, drops-banner.js   Drops-enabled detection + banner
  drops-hub.js          Drops hub (progress, claiming, all campaigns)
  drops-autoclaim.js    Automatic drop claiming
  rewards.js            Channel points / drops / watch-streak panel + redeeming
  watch-stats.js        Local watch-time tracking + stats view
  mod-log.js            Mod action log + Mod Chat tab
  mod-menu.js           Moderator room-control (shield) menu
  track-id.js           Song ID capture + result UI
  pin-auth.js           Twitch device-login modal (points/drops/pins)
  deps-banner.js        streamlink/ffmpeg bootstrap banner
  update-banner.js      In-app auto-updater button (Windows)
  tooltips.js           Themed tooltips
  format.js             Small display-formatting helpers
  emoji-data.js         Emoji list for the emote picker

src-tauri/src/          Backend (Rust)
  main.rs               Tauri app setup and command registration
  http.rs               Shared HTTP client (connection pooling)
  helix.rs              Twitch Helix (REST API) commands, plus GQL for channel
                          points, drops, predictions, polls, badges, follows,
                          clips, and reward redemptions
  twitch_device_auth.rs Twitch Android device-login token (points/drops/pins)
  pubsub.rs             Twitch PubSub (real-time redemptions + live balance)
  watch_heartbeat.rs    "minute watched" heartbeat (Drops + points accrual)
  drop_prefs.rs         Hidden drop campaigns (local)
  user_notes.rs         Per-user moderator notes (local)
  track_id.rs, song_id/ Song identification (native fingerprinter)
  stream_relay.rs       Spawns streamlink/ffmpeg, relays bytes over HTTP
                          (Windows), resolves ad-free m3u8 URLs (macOS),
                          and proxies HLS for CORS
  downloads.rs          VOD downloads (ffmpeg, progress, cancel)
  chat.rs               Twitch IRC WebSocket connection
  chat_commands.rs      Chat-backed commands (send, mod actions, chatters)
  whispers.rs           Whisper sending + local history
  oauth.rs              Native-browser OAuth flow (Twitch)
  eventsub.rs           Twitch EventSub (go-live notifications, raids, AutoMod)
  seventv_events.rs     7TV real-time emote updates
  seventv_cosmetics.rs  7TV name paints and badges
  link_preview.rs       Chat link hover-preview metadata fetching
  vod_progress.rs       Persisted VOD watch progress (resume)
  notify_prefs.rs       Persisted per-channel notification preferences
  deps_check.rs         streamlink/ffmpeg detection and install
  tray.rs               System tray icon/menu, window placement
  app_extras.rs         Launch-at-login state, backup file saving
  kick.rs               Kick API (streams, categories, VODs) as Helix shapes
  kick_chat.rs          Kick chat (Pusher) client
  kick_oauth.rs         Kick OAuth 2.1 + PKCE flow
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE), see that file for the full text. Twitch, the Twitch logo, and
related marks are trademarks of Twitch Interactive, Inc.; Kick and related marks
are trademarks of their respective owners. This project is an independent,
unofficial client.

## Kick support

The platform toggle in the header (right of **Browse**) switches the whole app
between Twitch and Kick: home feed, browse/categories/search, the sidebar's live
channels, and the watch box. Twitch is the default (purple border); Kick mode
turns the border green.

> **Platform note:** Kick support is developed and tested on Windows. On macOS it
> is currently **untested and may not work**. The macOS playback path differs
> from Windows (native HLS vs the byte relay), and Kick on that path hasn't been
> verified. Treat macOS Kick as unsupported for now.

### Kick login (optional, needed only to type in Kick chat)

Watching Kick streams and reading Kick chat need no login. **Sending** chat
messages does. Kick uses OAuth 2.1 with PKCE and, unlike Twitch's implicit flow,
requires a client secret even for desktop apps.

To enable it:

1. Register an app at <https://kick.com/settings/developer>.
2. Set its redirect URI to exactly `http://localhost:17544/`.
3. Request the `user:read` and `chat:write` scopes.
4. Provide the credentials to the build, either by editing the defaults in
   `src-tauri/src/kick_oauth.rs` (`CLIENT_ID` / `CLIENT_SECRET`) or by setting
   `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` as build-time environment variables,
   which override the defaults.
5. Rebuild.

Until this is done, `kick_oauth_configured()` returns false and the app simply
hides the "Log in with Kick" button, so Kick chat stays read-only rather than
offering a login that could only fail. Tokens are stored in
`kick_oauth_token.json` in the app's local data dir, separate from the Twitch
token, and are refreshed automatically when they expire (~1 hour).

> **Note on the Kick client secret:** Kick requires it even for desktop apps, but
> a secret shipped inside a distributed binary can't truly stay secret. Treat it
> as a semi-public app identifier; if it's ever abused, rotate it in the Kick
> developer console. To keep it out of a public repo entirely, supply it via the
> `KICK_CLIENT_SECRET` build-time env var instead of hardcoding it.
