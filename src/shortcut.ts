import type { ShortcutBinding, ShortcutDraft } from "./types";

const fileKeyAliases: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backspace: "backspace",
  Delete: "delete",
  End: "end",
  Enter: "enter",
  Escape: "escape",
  Home: "home",
  Insert: "insert",
  " ": "space",
  PageDown: "pagedown",
  PageUp: "pageup",
  Tab: "tab"
};

const displayAliases: Record<string, string> = {
  backspace: "Backspace",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Enter",
  escape: "Escape",
  home: "Home",
  insert: "Insert",
  keypad_enter: "Numpad Enter",
  left: "Left",
  pagedown: "Page Down",
  pageup: "Page Up",
  right: "Right",
  space: "Space",
  tab: "Tab",
  up: "Up"
};

const modifierOnlyKeys = new Set(["Alt", "Control", "Meta", "Shift"]);

function toTitleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function displayKeyLabel(key: string): string {
  if (displayAliases[key]) {
    return displayAliases[key];
  }

  if (key.length === 1 || /^f\d+$/i.test(key)) {
    return key.toUpperCase();
  }

  return toTitleCase(key);
}

export function normalizeShortcut(
  key: string,
  primaryModifier: number,
  mask: number,
  context: string | null
): string {
  const parts: string[] = [];

  if (primaryModifier === 1) {
    parts.push("ctrl");
  }

  if ((mask & 4) !== 0) {
    parts.push("meta");
  }

  if ((mask & 1) !== 0) {
    parts.push("shift");
  }

  if ((mask & 8) !== 0) {
    parts.push("alt");
  }

  parts.push(key.toLowerCase());
  return `${parts.join("+")}::${(context ?? "").toLowerCase()}`;
}

export function displayShortcut(
  key: string,
  primaryModifier: number,
  mask: number,
  context: string | null
): string {
  const parts: string[] = [];

  if (primaryModifier === 1) {
    parts.push("Ctrl");
  }

  if ((mask & 4) !== 0) {
    parts.push("Meta");
  }

  if ((mask & 1) !== 0) {
    parts.push("Shift");
  }

  if ((mask & 8) !== 0) {
    parts.push("Alt");
  }

  parts.push(displayKeyLabel(key));

  if (context) {
    return `${parts.join("+")} [${context}]`;
  }

  return parts.join("+");
}

export function createBinding(id: string, draft: ShortcutDraft): ShortcutBinding {
  return {
    id,
    key: draft.key,
    primaryModifier: draft.primaryModifier,
    mask: draft.mask,
    tailFlag: draft.tailFlag,
    context: draft.context,
    hasContextHint: Boolean(draft.context),
    display: displayShortcut(draft.key, draft.primaryModifier, draft.mask, draft.context),
    normalized: normalizeShortcut(draft.key, draft.primaryModifier, draft.mask, draft.context)
  };
}

export function draftFromBinding(binding: ShortcutBinding): ShortcutDraft {
  return {
    key: binding.key,
    primaryModifier: binding.primaryModifier,
    mask: binding.mask,
    tailFlag: binding.tailFlag,
    context: binding.context
  };
}

export function keyboardEventToDraft(event: React.KeyboardEvent<HTMLInputElement>): ShortcutDraft | null {
  if (modifierOnlyKeys.has(event.key)) {
    return null;
  }

  let key = event.key;

  if (event.code === "NumpadEnter") {
    key = "keypad_enter";
  } else if (fileKeyAliases[key]) {
    key = fileKeyAliases[key];
  } else if (key.length === 1) {
    key = key.toUpperCase();
  } else if (/^F\d{1,2}$/i.test(key)) {
    key = key.toUpperCase();
  } else {
    key = key.toLowerCase();
  }

  return {
    key,
    primaryModifier: event.ctrlKey ? 1 : 0,
    mask: (event.shiftKey ? 1 : 0) | (event.metaKey ? 4 : 0) | (event.altKey ? 8 : 0),
    tailFlag: 0,
    context: null
  };
}
