export function keepFocusInsideDialog(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (event.key !== "Tab" || dialog === null) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => element.getAttribute("aria-hidden") !== "true");
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (event.shiftKey === false && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
