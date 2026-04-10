export interface ShortcutSettings {
  prefix_key: string;
  next_sidebar_item: string;
  previous_sidebar_item: string;
  toggle_sidebar: string;
  rename_active_pane: string;
  focus_agent_input: string;
  zoom_active_pane: string;
  split_pane_vertical: string;
  split_pane_horizontal: string;
  kill_pane: string;
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
  prefix_key: "Ctrl+2",
  next_sidebar_item: "Alt+Tab",
  previous_sidebar_item: "Alt+Shift+Tab",
  toggle_sidebar: "Meta+e",
  rename_active_pane: "Meta+r",
  focus_agent_input: "Meta+n",
  zoom_active_pane: "Prefix z",
  split_pane_vertical: "Prefix v",
  split_pane_horizontal: "Prefix s",
  kill_pane: "Prefix q",
  move_pane_left: "Ctrl+h",
  move_pane_down: "Ctrl+j",
  move_pane_up: "Ctrl+k",
  move_pane_right: "Ctrl+l",
};

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: "prefix_key", label: "Prefix key" },
  { id: "next_sidebar_item", label: "Next sidebar item" },
  { id: "previous_sidebar_item", label: "Previous sidebar item" },
  { id: "toggle_sidebar", label: "Toggle sidebar" },
  { id: "rename_active_pane", label: "Rename active pane" },
  { id: "focus_agent_input", label: "Focus agent input" },
  { id: "zoom_active_pane", label: "Zoom active pane" },
  { id: "split_pane_vertical", label: "Split pane vertically" },
  { id: "split_pane_horizontal", label: "Split pane horizontally" },
  { id: "kill_pane", label: "Kill focused pane" },
  { id: "move_pane_left", label: "Move to left pane" },
  { id: "move_pane_down", label: "Move to pane below" },
  { id: "move_pane_up", label: "Move to pane above" },
  { id: "move_pane_right", label: "Move to right pane" },
];

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);

const SPECIAL_KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
  Esc: "Esc",
};

const DASH_MODIFIER_ALIASES: Record<string, string> = {
  c: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  a: "Alt",
  alt: "Alt",
  option: "Alt",
  s: "Shift",
  shift: "Shift",
  m: "Meta",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
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

function expandDashModifiers(binding: string): string {
  return binding.replace(/(^|[\s+])([A-Za-z]+)-(?=[^\s+])/g, (match, prefix: string, rawModifier: string) => {
    const normalized = DASH_MODIFIER_ALIASES[rawModifier.toLowerCase()];
    if (!normalized) return match;
    return `${prefix}${normalized}+`;
  });
}

function normalizeShortcutStroke(parts: string[]): string {
  const modifiers = MODIFIER_ORDER.filter((modifier) => parts.includes(modifier));
  const key = parts.find((part) => !MODIFIER_SET.has(part));
  return [...modifiers, key].filter(Boolean).join("+");
}

function parseShortcutStroke(stroke: string): { key: string; modifiers: Set<string> } {
  const parts = stroke.split("+").map((part) => normalizeKeyPart(part)).filter(Boolean);
  return {
    key: parts.find((part) => !MODIFIER_SET.has(part)) ?? "",
    modifiers: new Set(parts.filter((part): part is typeof MODIFIER_ORDER[number] => MODIFIER_SET.has(part))),
  };
}

function strokesMatchWithCarry(expectedStroke: string, actualStroke: string, carriedModifiers?: Set<string>): boolean {
  const expected = parseShortcutStroke(expectedStroke);
  const actual = parseShortcutStroke(actualStroke);
  if (!expected.key || expected.key !== actual.key) return false;

  for (const modifier of expected.modifiers) {
    if (!actual.modifiers.has(modifier)) return false;
  }

  for (const modifier of actual.modifiers) {
    if (expected.modifiers.has(modifier)) continue;
    if (!carriedModifiers?.has(modifier)) return false;
  }

  return true;
}

function resolvePrefixReferences(binding: string, prefixKey: string): string {
  return binding.replace(/\bprefix\b/gi, prefixKey);
}

function bindingToTokens(binding: string): string[] {
  return expandDashModifiers(binding)
    .split(/[+\s]+/)
    .map((part) => normalizeKeyPart(part))
    .filter(Boolean);
}

export function shortcutBindingToSequence(binding: string, prefixKey = DEFAULT_SHORTCUTS.prefix_key): string[] {
  const tokens = bindingToTokens(resolvePrefixReferences(binding, prefixKey));

  const sequence: string[] = [];
  let strokeParts: string[] = [];

  for (const token of tokens) {
    strokeParts.push(token);
    if (!MODIFIER_SET.has(token)) {
      const stroke = normalizeShortcutStroke(strokeParts);
      if (stroke) sequence.push(stroke);
      strokeParts = [];
    }
  }

  return sequence.slice(0, 2);
}

export function normalizeShortcutBinding(binding: string, prefixKey = DEFAULT_SHORTCUTS.prefix_key): string {
  return shortcutBindingToSequence(binding, prefixKey).join(" ");
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
  if (!key || MODIFIER_SET.has(key)) return "";
  return normalizeShortcutStroke([...modifiers, key].filter(Boolean));
}

export function shortcutMatches(event: KeyboardEvent, binding: string, prefixKey = DEFAULT_SHORTCUTS.prefix_key): boolean {
  const sequence = shortcutBindingToSequence(binding, prefixKey);
  if (sequence.length !== 1) return false;
  return eventToShortcutBinding(event) === sequence[0];
}

export function shortcutStartsWith(binding: string, firstStroke: string, prefixKey = DEFAULT_SHORTCUTS.prefix_key): boolean {
  const sequence = shortcutBindingToSequence(binding, prefixKey);
  return sequence.length > 1 && sequence[0] === normalizeShortcutBinding(firstStroke, prefixKey);
}

export function shortcutCompletesSequence(binding: string, strokes: string[], prefixKey = DEFAULT_SHORTCUTS.prefix_key): boolean {
  const sequence = shortcutBindingToSequence(binding, prefixKey);
  return sequence.length === strokes.length
    && sequence.every((stroke, index) => {
      const actualStroke = normalizeShortcutBinding(strokes[index] ?? "", prefixKey);
      if (index === 0) return stroke === actualStroke;
      const previousStroke = normalizeShortcutBinding(strokes[index - 1] ?? "", prefixKey);
      const carriedModifiers = parseShortcutStroke(previousStroke).modifiers;
      return strokesMatchWithCarry(stroke, actualStroke, carriedModifiers);
    });
}

function formatShortcutPart(part: string): string {
  if (part === "Meta") return "Cmd";
  if (part.length === 1) return part.toUpperCase();
  return part;
}

export function formatShortcutSteps(binding: string): string[][] {
  const steps: string[][] = [];
  let currentStroke: string[] = [];

  for (const token of bindingToTokens(binding)) {
    if (token === "Prefix") {
      if (currentStroke.length > 0) {
        steps.push(currentStroke.map(formatShortcutPart));
        currentStroke = [];
      }
      steps.push(["Prefix"]);
      continue;
    }

    currentStroke.push(token);
    if (!MODIFIER_SET.has(token)) {
      steps.push(currentStroke.map(formatShortcutPart));
      currentStroke = [];
    }
  }

  if (currentStroke.length > 0) {
    steps.push(currentStroke.map(formatShortcutPart));
  }

  return steps;
}

export function resolveShortcutSettings(
  settings: { shortcuts?: Partial<ShortcutSettings> | null } | null | undefined,
): ShortcutSettings {
  return {
    ...DEFAULT_SHORTCUTS,
    ...(settings?.shortcuts ?? {}),
  };
}
