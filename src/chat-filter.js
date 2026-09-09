// Chat filter: user-defined lists of emotes, words, and phrases that cause a message to be dropped
// from chat entirely. storage + the settings modal live here; the actual matching lives in chat.js
// (it needs the parsed-emote maps to match emotes precisely). modeled on FrankerFaceZ's Chat >
// Filtering > Block, trimmed to the three list types and a single "remove the whole message" action.

const STORAGE_KEY = "chatFilter";

// shape: { emotes: string[], words: string[], strings: string[] }
export function loadFilter() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      emotes: Array.isArray(raw.emotes) ? raw.emotes : [],
      words: Array.isArray(raw.words) ? raw.words : [],
      strings: Array.isArray(raw.strings) ? raw.strings : [],
    };
  } catch {
    return { emotes: [], words: [], strings: [] };
  }
}

export function saveFilter(data) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      emotes: data.emotes || [],
      words: data.words || [],
      strings: data.strings || [],
    })
  );
}

// the three lists share behavior; only their labels, hints, and matching (in chat.js) differ.
// emotes are case-sensitive (emote names are), words/phrases are matched case-insensitively, so we
// lowercase-dedupe those for storage
const SECTIONS = [
  {
    key: "emotes",
    title: "Blocked emotes",
    hint: "Exact emote name, case-sensitive (e.g. LULW). Hides messages that actually use the emote, not people typing the word.",
    placeholder: "Emote name",
    caseSensitive: true,
  },
  {
    key: "words",
    title: "Blocked words",
    hint: "Whole word, case-insensitive. Blocking “gg” won’t catch “eggs”.",
    placeholder: "Word",
    caseSensitive: false,
  },
  {
    key: "strings",
    title: "Blocked phrases",
    hint: "Any text, case-insensitive. Matches anywhere in a message (e.g. “check out my”).",
    placeholder: "Phrase or text",
    caseSensitive: false,
  },
];

let overlay = null;

// opens the settings modal. onChange() is called after every add/remove (already persisted) so the
// caller can recompile the live filter
export function openChatFilterModal(onChange) {
  if (overlay) closeModal();
  const data = loadFilter();

  overlay = document.createElement("div");
  overlay.className = "chat-filter-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  const modal = document.createElement("div");
  modal.className = "chat-filter-modal";

  const header = document.createElement("div");
  header.className = "chat-filter-header";
  header.innerHTML = `<span>Chat Filter</span>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "chat-filter-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", closeModal);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const intro = document.createElement("div");
  intro.className = "chat-filter-intro";
  intro.textContent = "Messages matching any rule below are hidden from chat. Your own messages are never filtered.";
  modal.appendChild(intro);

  for (const section of SECTIONS) {
    modal.appendChild(buildSection(section, data, onChange));
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const esc = (e) => {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", esc);
    }
  };
  document.addEventListener("keydown", esc);
}

function closeModal() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

function buildSection(section, data, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "chat-filter-section";

  const title = document.createElement("div");
  title.className = "chat-filter-section-title";
  title.textContent = section.title;
  wrap.appendChild(title);

  const hint = document.createElement("div");
  hint.className = "chat-filter-hint";
  hint.textContent = section.hint;
  wrap.appendChild(hint);

  const inputRow = document.createElement("div");
  inputRow.className = "chat-filter-input-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat-filter-input";
  input.placeholder = section.placeholder;
  const addBtn = document.createElement("button");
  addBtn.className = "chat-filter-add";
  addBtn.textContent = "Add";
  inputRow.appendChild(input);
  inputRow.appendChild(addBtn);
  wrap.appendChild(inputRow);

  const list = document.createElement("div");
  list.className = "chat-filter-list";
  wrap.appendChild(list);

  const renderList = () => {
    list.innerHTML = "";
    if (data[section.key].length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-filter-empty";
      empty.textContent = "Nothing blocked yet.";
      list.appendChild(empty);
      return;
    }
    for (const entry of data[section.key]) {
      const chip = document.createElement("span");
      chip.className = "chat-filter-chip";
      const label = document.createElement("span");
      label.textContent = entry;
      const rm = document.createElement("button");
      rm.className = "chat-filter-chip-remove";
      rm.setAttribute("aria-label", `Remove ${entry}`);
      rm.textContent = "✕";
      rm.addEventListener("click", () => {
        data[section.key] = data[section.key].filter((x) => x !== entry);
        saveFilter(data);
        renderList();
        onChange?.();
      });
      chip.appendChild(label);
      chip.appendChild(rm);
      list.appendChild(chip);
    }
  };

  const addEntry = () => {
    let val = input.value.trim();
    if (!val) return;
    if (!section.caseSensitive) val = val.toLowerCase();
    // dedupe (case-sensitive for emotes, already-lowered for the others)
    if (!data[section.key].includes(val)) {
      data[section.key].push(val);
      saveFilter(data);
      renderList();
      onChange?.();
    }
    input.value = "";
    input.focus();
  };
  addBtn.addEventListener("click", addEntry);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addEntry();
    }
  });

  renderList();
  return wrap;
}
