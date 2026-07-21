export type DictationShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

export function isDictationShortcut(event: DictationShortcutEvent) {
  return (
    event.key.toLowerCase() === "m" &&
    event.metaKey !== event.ctrlKey &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.shiftKey
  );
}

export function dictationShortcutLabel(platform: string) {
  return /mac|iphone|ipad|ipod/iu.test(platform) ? "⌘⇧M" : "Ctrl+Shift+M";
}
