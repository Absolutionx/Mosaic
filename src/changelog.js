// What's new (whats-new.js): one entry per released version, newest first. Add the entry when bumping the
// version; the window shows after an update and lists what changed since the version you had before.
//   kind: "new" | "improved" | "fixed"   title: a few words   desc: one or two plain sentences
export const CHANGELOG = [
  {
    version: "1.5.1",
    items: [
      { kind: "new", title: "Video on hover", desc: "Rest the mouse on a live stream, on Home, in Browse or in the sidebar's preview card, and it plays right there, muted. VODs too, from where you left off. Settings › Home & MultiView › Video on hover." },
      { kind: "improved", title: "Emotes in pinned messages", desc: "Pinned messages show their emotes, Twitch sub emotes from other channels included, and no longer wait for the channel's emotes to load first." },
      { kind: "fixed", title: "Emote picker tabs", desc: "The last tab (emoji) was cut off. All the tabs fit now, and in a narrow chat the row scrolls." },
    ],
  },
  {
    version: "1.5.0",
    items: [
      { kind: "new", title: "Amazon Luna benefits", desc: "A crown in the header with the games and in-game loot you can claim with Prime this month, as on twitch.tv. Loot codes are claimed right in Mosaic." },
      { kind: "new", title: "Notifications", desc: "A bell in the header with your Twitch notifications, as on twitch.tv: emote unlocks, gift subs, stream streaks, new VODs and more. Channels and VODs open right in Mosaic." },
      { kind: "new", title: "What's new", desc: "This window, after each update. Open it again any time from Settings › App." },
      { kind: "new", title: "Subscribed · 2 days left", desc: "When a sub that won't renew ends within 3 days, the Subscribe button says how long is left, and chat tells you once. Settings › Notifications › Show it on the channel." },
      { kind: "improved", title: "A tidier header", desc: "The platform switch and your account are icons now, and the account button shows your Twitch profile picture. Hover them for what they say." },
      { kind: "improved", title: "Emote picker", desc: "Restyled to match the rest of the app." },
      { kind: "improved", title: "Sharing a sub anniversary", desc: "Share now opens a card like Twitch's: who and how many months, your streak as an option, and a message box." },
    ],
  },
  {
    version: "1.4.9",
    items: [
      { kind: "new", title: "Close predictions and polls", desc: "Running predictions and polls now have a close button, not just minimize. A prediction you put points on comes back with its result." },
    ],
  },
  {
    version: "1.4.8",
    items: [
      { kind: "new", title: "Muted sections in VODs", desc: "Choose what happens at parts muted for copyright: play them, ask with a Skip button, or skip them. Settings › Player › VODs, or the player's settings menu." },
    ],
  },
  {
    version: "1.4.7",
    items: [
      { kind: "improved", title: "Safer Twitch login", desc: "Login now checks it was started by Mosaic, and the login token is removed from your browser's history." },
      { kind: "improved", title: "Up and Down in a long message", desc: "In a message that wraps onto several lines, Up and Down move the cursor between lines. They bring back sent messages from the first or last line." },
      { kind: "improved", title: "Much less disk writing", desc: "VOD and Kick video is no longer written to the app's cache as it plays, old update installers are cleaned up, and watch time is saved once a minute." },
      { kind: "fixed", title: "Emotes turning into @mentions", desc: "Completing an emote could insert an @mention of someone with the same name." },
    ],
  },
  {
    version: "1.4.6",
    items: [
      { kind: "new", title: "You and this channel", desc: "The Subscribe button opens your sub (months, streak, tier or Prime, gift), how long you've followed, messages you've sent, your watch time and points." },
      { kind: "new", title: "Subscription ending reminders", desc: "A notification before a sub that won't renew runs out. Settings › Notifications." },
      { kind: "improved", title: "Smoother fullscreen", desc: "Entering and leaving fullscreen no longer jumps or flashes." },
      { kind: "improved", title: "@ name suggestions", desc: "The suggestion list matches the rest of the app." },
      { kind: "fixed", title: "Messages that mentioned you", desc: "Messages mentioning you were sometimes not shown at all." },
      { kind: "fixed", title: "Chat box after pressing Up", desc: "Bringing back a long sent message no longer cuts off its last line." },
      { kind: "fixed", title: "Signing out, Escape and notes", desc: "Signing out clears everything from the old account, Escape closes the open menu first, and a user note is saved when the card closes." },
      { kind: "improved", title: "Security", desc: "The local video server only answers Mosaic, and link previews never open addresses on your own network." },
    ],
  },
];
