// One Escape handler for stacked overlays (command palette, Settings panel). Each open overlay pushes a close
// function; Escape closes only the TOP one, one per press, and never falls through to the app's own Escape
// shortcuts (exiting theater mode / fullscreen) while any overlay is open. Separate per-overlay listeners
// ran in registration order, so the panel underneath could close first and a later Escape leaked through.

const stack = [];

// returns a function that removes this entry (call it when the overlay closes by any means)
export function pushEscape(close) {
  const entry = { close };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

// capture phase on window: runs before any document/element keydown handler, including the app's shortcuts
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const top = stack[stack.length - 1];
  top.close();
}, true);
