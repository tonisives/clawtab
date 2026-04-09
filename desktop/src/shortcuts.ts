export interface ShortcutSettings {
  next_sidebar_item: string;
  previous_sidebar_item: string;
  toggle_sidebar: string;
  split_pane_vertical: string;
  split_pane_horizontal: string;
  move_pane_left: string;
  move_pane_down: string;
  move_pane_up: string;
  move_pane_right: string;
}

export type ShortcutId = keyof ShortcutSettings;

export interface ShortcutDefinition {
  id: ShortcutId;
  label: string;
}

export const DEFAULT_SHORTCUTS: ShortcutSettings = {
  next_sidebar_item: "Alt+Tab",
  previous_sidebar_item: "Alt+Shift+Tab",
  toggle_sidebar: "Meta+e",
  split_pane_vertical: "Ctrl+v",
  split_pane_horizontal: "Ctrl+s",
  move_pane_left: "Ctrl+h",
  move_pane_down: "Ctrl+j",
  move_pane_up: "Ctrl+k",
  move_pane_right: "Ctrl+l",
};

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: "next_sidebar_item", label: "Next sidebar item" },
  { id: "previous_sidebar_item", label: "Previous sidebar item" },
  { id: "toggle_sidebar", label: "Toggle sidebar" },
  { id: "split_pane_vertical", label: "Split pane vertically" },
  { id: "split_pane_horizontal", label: "Split pane horizontally" },
  { id: "move_pane_left", label: "Move to left pane" },
  { id: "move_pane_down", label: "Move to pane below" },
  { id: "move_pane_up", label: "Move to pane above" },
  { id: "move_pane_right", label: "Move to right pane" },
];

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

const SPECIAL_KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Esc: "Esc",
};

function normalizeKeyPart(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length === 1) {
    return trimmed === " " ? "Space" : trimmed.toLowerCase();
  }
  if (trimmed in SPECIAL_KEY_ALIASES) return SPECIAL_KEY_ALIASES[trimmed];

  const lower = trimmed.toLowerCase();
  if (lower === "cmd" || lower === "command" || lower === "meta") return "Meta";
  if (lower === "ctrl" || lower === "control") return "Ctrl";
  if (lower === "alt" || lower === "option") return "Alt";
  if (lower === "shift") return "Shift";
  if (lower === "space") return "Space";
  if (lower === "tab") return "Tab";
  if (lower === "enter" || lower === "return") return "Enter";
  if (lower === "backspace") return "Backspace";
  if (lower === "delete") return "Delete";
  if (lower === "escape" || lower === "esc") return "Esc";
  return trimmed;
}

export function normalizeShortcutBinding(binding: string): string {
  const rawParts = binding
    .split("+")
    .map((part) => normalizeKeyPart(part))
    .filter(Boolean);

  const modifiers = MODIFIER_ORDER.filter((modifier) => rawParts.includes(modifier));
  const key = rawParts.find((part) => !MODIFIER_ORDER.includes(part as typeof MODIFIER_ORDER[number]));

  return [...modifiers, key].filter(Boolean).join("+");
}

function keyFromEvent(event: KeyboardEvent): string {
  if ((event.ctrlKey || event.metaKey || event.altKey) && event.code.startsWith("Key")) {
    return event.code.slice(3).toLowerCase();
  }
  if ((event.ctrlKey || event.metaKey || event.altKey) && event.code.startsWith("Digit")) {
    return event.code.slice(5);
  }
  if (event.key in SPECIAL_KEY_ALIASES) return SPECIAL_KEY_ALIASES[event.key];
  if (event.key === "Dead") return "";
  if (event.key.length === 1) return event.key === " " ? "Space" : event.key.toLowerCase();
  return normalizeKeyPart(event.key);
}

export function eventToShortcutBinding(event: KeyboardEvent): string {
  const modifiers = [
    event.ctrlKey ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    event.metaKey ? "Meta" : "",
  ].filter(Boolean);

  const key = keyFromEvent(event);
  if (!key || MODIFIER_ORDER.includes(key as typeof MODIFIER_ORDER[number])) return "";
  return normalizeShortcutBinding([...modifiers, key].filter(Boolean).join("+"));
}

export function shortcutMatches(event: KeyboardEvent, binding: string): boolean {
  const normalizedBinding = normalizeShortcutBinding(binding);
  if (!normalizedBinding) return false;
  return eventToShortcutBinding(event) === normalizedBinding;
}

export function formatShortcutKeys(binding: string): string[] {
  return normalizeShortcutBinding(binding)
    .split("+")
    .filter(Boolean)
    .map((part) => {
      if (part === "Meta") return "Cmd";
      if (part.length === 1) return part.toUpperCase();
      return part;
    });
}

export function resolveShortcutSettings(
  settings: { shortcuts?: Partial<ShortcutSettings> | null } | null | undefined,
): ShortcutSettings {
  return {
    ...DEFAULT_SHORTCUTS,
    ...(settings?.shortcuts ?? {}),
  };
}
