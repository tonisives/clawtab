import {
  APP_SHORTCUT_EVENT,
  eventToShortcutBinding,
  normalizeShortcutBinding,
  shortcutCompletesSequence,
  shortcutMatches,
  shortcutStartsWith,
  type ShortcutSettings,
} from "../../shortcuts";
import type { PaneInstance } from "./types";

type HandledKeyboardEvent = KeyboardEvent & { __clawtabShortcutHandled?: boolean };

function dispatchAppShortcut(binding: string, paneId: string, action?: string) {
  window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { action, binding, paneId } }));
}

function collectAppBindings(shortcuts: ShortcutSettings): string[] {
  return [
    shortcuts.next_sidebar_item,
    shortcuts.previous_sidebar_item,
    shortcuts.toggle_sidebar,
    shortcuts.rename_active_pane,
    shortcuts.focus_agent_input,
    shortcuts.zoom_active_pane,
    shortcuts.split_pane_vertical,
    shortcuts.split_pane_horizontal,
    shortcuts.kill_pane,
    shortcuts.move_pane_left,
    shortcuts.move_pane_down,
    shortcuts.move_pane_up,
    shortcuts.move_pane_right,
    shortcuts.reveal_in_sidebar,
    shortcuts.toggle_auto_yes,
    shortcuts.enter_copy_mode,
    shortcuts.back_navigation,
    shortcuts.forward_navigation,
  ];
}

function actionForBinding(binding: string, shortcuts: ShortcutSettings): string | undefined {
  const normalized = normalizeShortcutBinding(binding, shortcuts.prefix_key);
  if (normalized === normalizeShortcutBinding(shortcuts.rename_active_pane, shortcuts.prefix_key)) {
    return "rename_active_pane";
  }
  return undefined;
}

function handleKeyUp(inst: PaneInstance, e: KeyboardEvent): boolean {
  if (inst.suppressedKeyRef.current && e.key === inst.suppressedKeyRef.current) {
    if (e.type === "keyup") inst.suppressedKeyRef.current = null;
    return false;
  }
  return true;
}

function handlePendingSequence(
  inst: PaneInstance,
  e: HandledKeyboardEvent,
  stroke: string | null,
  appBindings: string[],
  shortcuts: ShortcutSettings,
): boolean {
  if (stroke) {
    const sequenceBinding = appBindings.find((binding) =>
      shortcutCompletesSequence(binding, [inst.pendingShortcutStrokeRef.current ?? "", stroke], shortcuts.prefix_key),
    );
    if (sequenceBinding && !e.__clawtabShortcutHandled) {
      e.__clawtabShortcutHandled = true;
      dispatchAppShortcut(sequenceBinding, inst.paneId, actionForBinding(sequenceBinding, shortcuts));
    }
    inst.pendingShortcutStrokeRef.current = null;
    inst.suppressedKeyRef.current = e.key;
  }
  e.preventDefault();
  e.stopPropagation();
  return false;
}

export function attachPaneShortcuts(inst: PaneInstance) {
  inst.terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return handleKeyUp(inst, e);

    const shortcuts = inst.shortcutsRef.current;
    const appBindings = collectAppBindings(shortcuts);

    if (inst.pendingShortcutStrokeRef.current && e.key === "Escape") {
      inst.pendingShortcutStrokeRef.current = null;
      inst.suppressedKeyRef.current = "Escape";
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    const stroke = eventToShortcutBinding(e);
    if (inst.pendingShortcutStrokeRef.current) {
      return handlePendingSequence(inst, e as HandledKeyboardEvent, stroke, appBindings, shortcuts);
    }

    if (!stroke) return true;

    if (appBindings.some((binding) => shortcutStartsWith(binding, stroke, shortcuts.prefix_key))) {
      inst.pendingShortcutStrokeRef.current = stroke;
      inst.suppressedKeyRef.current = e.key;
      e.preventDefault();
      e.stopPropagation();
      return false;
    }

    const singleStrokeBinding = appBindings.find((binding) => shortcutMatches(e, binding, shortcuts.prefix_key));
    if (singleStrokeBinding) {
      const handledEvent = e as HandledKeyboardEvent;
      if (!handledEvent.__clawtabShortcutHandled) {
        dispatchAppShortcut(singleStrokeBinding, inst.paneId, actionForBinding(singleStrokeBinding, shortcuts));
      }
      inst.suppressedKeyRef.current = e.key;
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  });
}
