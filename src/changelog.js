// What's new (whats-new.js): one entry per released version, newest first. Add the entry when bumping the
// version; the window shows after an update and lists what changed since the version you had before.
//   kind: "new" | "improved" | "fixed"   title: a few words   desc: one or two plain sentences
//   top: true puts an item first, ahead of the usual New / Improved / Fixed grouping
export const CHANGELOG = [
  {
    version: "1.6.0",
    items: [
      { kind: "fixed", top: true, title: "Drops keep counting", desc: "Drop progress could stop after a while until you logged in again, without any warning. Mosaic now notices when Twitch stops counting, recovers on its own, and shows the Drops bar if it can't." },
      { kind: "fixed", top: true, title: "Available drops are back", desc: "Twitch stopped sharing its full campaign list with Mosaic, so the Drops hub showed none. Mosaic now finds campaigns from the streams that have drops on, loading more as you scroll, with their rewards and the Account not linked note." },
      { kind: "new", title: "Themes", desc: "Pick a look in Settings > Appearance: Mosaic, Midnight, OLED Black, Graphite, Forest, Rosé and Ocean, plus the light Daylight and Paper. Each one changes the accent too, from the seek bar to Drops tags and hype train glows, and you can set your own colors on top." },
      { kind: "new", title: "Customize anything", desc: "Press Start under Settings > Appearance > Customize parts, then click any part of Mosaic to change its colors, glow, corners or size, or hide it. Over 200 parts, including hype trains, predictions and chat events, are also in the searchable All parts list." },
      { kind: "new", title: "Custom CSS", desc: "Write your own CSS for anything the picker doesn't cover, with a switch to turn it off at once." },
      { kind: "new", title: "Share themes", desc: "Copy your whole look as a theme code to send to a friend, or paste one someone shared." },
      { kind: "improved", title: "Readable names on light themes", desc: "On a light theme, chat names too pale to read on white are darkened automatically." },
      { kind: "fixed", title: "Cursor over a loading stream", desc: "The mouse pointer no longer disappears over the video while a stream is still loading." },
    ],
  },
  {
    version: "1.5.9",
    items: [
      { kind: "fixed", top: true, title: "Taskbar icon", desc: "If your taskbar kept showing Mosaic's old icon after updating, Windows now switches it to the new one." },
      { kind: "new", title: "Preload favorites", desc: "Mosaic can keep your live favorites loading in the background so they start instantly when you open them. Turn it on in Settings > Player > Preload favorites, and choose how many and which ones. Each preloaded channel uses about as much data as watching it." },
      { kind: "new", title: "Search your drops", desc: "The Drops hub has a search box that finds games, campaigns and rewards." },
      { kind: "improved", title: "Drops you're earning come first", desc: "The campaign the stream you're watching is earning moves to the top of In progress, marked Earning now. Campaigns that have ended no longer show unless a reward is still waiting to be claimed." },
      { kind: "new", title: "Know when drops aren't counting", desc: "If drops stop counting, Mosaic first tries to fix it on its own. If it can't, a bar above the video tells you why and lets you reconnect Twitch in one click." },
      { kind: "fixed", title: "Staying connected to Twitch", desc: "Your Twitch connection could be removed when Twitch refused to renew it, even though it still worked, which quietly stopped drops and channel points. Mosaic now keeps it until Twitch actually stops accepting it." },
      { kind: "improved", title: "A new icon", desc: "Mosaic has a new icon, sharp at every taskbar size and without the dark tile around it." },
      { kind: "fixed", title: "Notification bell", desc: "Clicking a channel's bell again now closes its menu instead of reopening it." },
    ],
  },
  {
    version: "1.5.8",
    items: [
      { kind: "new", title: "Preload favorites", desc: "Mosaic can keep your live favorites loading in the background so they start instantly when you open them. Turn it on in Settings > Player > Preload favorites, and choose how many and which ones. Each preloaded channel uses about as much data as watching it." },
      { kind: "new", title: "Search your drops", desc: "The Drops hub has a search box that finds games, campaigns and rewards." },
      { kind: "improved", title: "Drops you're earning come first", desc: "The campaign the stream you're watching is earning moves to the top of In progress, marked Earning now. Campaigns that have ended no longer show unless a reward is still waiting to be claimed." },
      { kind: "new", title: "Know when drops aren't counting", desc: "If drops stop counting, Mosaic first tries to fix it on its own. If it can't, a bar above the video tells you why and lets you reconnect Twitch in one click." },
      { kind: "fixed", title: "Staying connected to Twitch", desc: "Your Twitch connection could be removed when Twitch refused to renew it, even though it still worked, which quietly stopped drops and channel points. Mosaic now keeps it until Twitch actually stops accepting it." },
      { kind: "improved", title: "A new icon", desc: "Mosaic has a new icon, sharp at every taskbar size and without the dark tile around it." },
      { kind: "fixed", title: "Notification bell", desc: "Clicking a channel's bell again now closes its menu instead of reopening it." },
    ],
  },
  {
    version: "1.5.7",
    items: [
      { kind: "fixed", title: "Spelling", desc: "Fixed spelling in a few places across the app." },
    ],
  },
  {
    version: "1.5.6",
    items: [
      { kind: "improved", title: "Safer Twitch login", desc: "Your Twitch login now stays inside Mosaic's core instead of being handed to the app's interface, so nothing running in the interface can read it. Each window can also only do what it needs: the picture-in-picture window can play video and nothing else." },
      { kind: "new", title: "Developer tools setting", desc: "Inspect and Ctrl+Shift+I are now off by default. Turn them on in Settings > App > Developer tools if you need them, and never paste code someone sent you into them." },
      { kind: "fixed", title: "Staying logged in to Kick", desc: "Sending Kick chat right as your login renewed could sign you out, and so could a brief network drop. Mosaic now renews one at a time and only signs you out when Kick actually rejects the login. If Kick ever refuses Mosaic itself, you'll see a clear message instead of a vague failure." },
      { kind: "improved", title: "Hardening", desc: "Stricter handling of 7TV name paints, prediction overlays and link previews, and the Twitch login now also guards the IPv6 address it listens on." },
      { kind: "improved", title: "Cleaner picture-in-picture", desc: "Right-clicking the picture-in-picture window no longer shows the browser's Back / Refresh / Print menu." },
    ],
  },
  {
    version: "1.5.5",
    items: [
      { kind: "fixed", title: "Drop progress", desc: "Twitch changed how it counts drop minutes, so watching in Mosaic stopped advancing drops even though channel points kept coming. Mosaic now reports watching the way Twitch's own player does, and drop progress counts again." },
      { kind: "improved", title: "Spell check menu colors", desc: "Spelling suggestions in the right-click menu now use the same colors as the rest of the menu." },
    ],
  },
  {
    version: "1.5.4",
    items: [
      { kind: "fixed", title: "Channel points and drops", desc: "Twitch changed how watch time is reported, so watching in Mosaic stopped earning channel points and drop progress. Mosaic now reports it the way twitch.tv does, and both accrue again." },
      { kind: "improved", title: "Spell check menu", desc: "Right-clicking in the chat box now opens a menu that matches the rest of Mosaic instead of the plain Windows one. Spelling suggestions sit at the top; pick one to fix the word (Ctrl+Z undoes it)." },
    ],
  },
  {
    version: "1.5.3",
    items: [
      { kind: "new", title: "Streamlink updates", desc: "Streamlink is what blocks Twitch ads, so Mosaic now checks for a newer one each time it starts and updates it with one click: it downloads the official installer, checks it against its published checksum and installs it. A stream that's playing restarts when it's done. When Mosaic has an update too, one \"Update both\" button installs the two together." },
      { kind: "new", title: "Spell check in chat", desc: "Misspelled words get underlined while you type a message; right-click one for suggestions. Turn it off in Settings > Chat." },
      { kind: "improved", title: "Faster chat and Browse", desc: "Busy chats render about twice as fast, the emote picker opens and searches several times faster, and Browse no longer stutters as you scroll further down." },
      { kind: "improved", title: "Less CPU while idle", desc: "Hype train glows now pulse on the graphics card. Animated 7TV name paints are now off by default, because they kept redrawing chat; turn them back on in Settings › Chat › Animate name paints." },
      { kind: "improved", title: "Less memory", desc: "While Mosaic waits in the tray or minimized with nothing playing, it hands memory back to Windows. New Settings › Player › Live rewind sets how much live video is kept for rewinding (2 minutes of 1080p is about 90 MB); Kick streams now follow it too instead of keeping unlimited video." },
      { kind: "improved", title: "Fewer requests", desc: "The channel list checks who's live with half as many Twitch requests, skips Recommended while Mosaic is hidden, and long lists load images only as they scroll into view." },
      { kind: "improved", title: "Calmer play button", desc: "The play button in the middle of a paused stream or VOD no longer turns purple when you hover it." },
      { kind: "fixed", title: "Ready for newer streamlink", desc: "Newer streamlink always blocks Twitch ads by itself and is retiring the old ad-blocking option; Mosaic now only passes that option to versions that still need it, so a future streamlink can't stop streams from starting." },
      { kind: "fixed", title: "Enabling pinned messages", desc: "Twitch stopped accepting the sign-in Mosaic used for pinned messages, sub emotes and channel points, so turning them on failed with \"invalid client\". Mosaic now signs in the way Twitch still allows; if you already had them on, nothing changes." },
      { kind: "fixed", title: "Your emotes in the picker", desc: "Twitch changed how it lists the emotes you can use, so sub emotes from other channels stopped showing in the emote picker. They're back." },
    ],
  },
  {
    version: "1.5.2",
    items: [
      { kind: "improved", title: "Safer sign-ins", desc: "On Windows, your Twitch and Kick logins are now kept in Windows Credential Manager instead of plain files. Existing logins move over by themselves." },
      { kind: "improved", title: "Faster VODs and previews", desc: "VODs, Kick streams, clips and hover previews start playing as video arrives instead of waiting for each piece to finish downloading, so starts and seeks are quicker." },
      { kind: "improved", title: "Lighter in the background", desc: "While Mosaic is minimized or in the tray, chat stops checking for pinned messages, hype trains and sub anniversaries, and catches up the moment you're back." },
      { kind: "improved", title: "Readable chat names", desc: "Chatters whose name color was too dark to read comfortably on the chat background are lightened a little more, and the chat status line is easier to read." },
      { kind: "fixed", title: "Kick chat messages", desc: "Kick moved its chat to a new server, so Kick chat showed no messages. Mosaic now connects the way kick.com does." },
      { kind: "fixed", title: "Login problems explained", desc: "If the Twitch or Kick login can't start or doesn't finish (another program using its port, say), Mosaic now says why instead of doing nothing." },
      { kind: "fixed", title: "Security hardening", desc: "Updated the app's secure-connection libraries; link previews can't reach your own network or be slowed down by a hostile page; the login and video servers on your computer reject anything that isn't Mosaic; picture-in-picture windows get only the permissions they need." },
    ],
  },
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
