export function resolveSplashInputAction(
  input: string,
  key: {
    escape?: boolean | undefined;
    ctrl?: boolean | undefined;
  },
): "dismiss" | "quit" | undefined {
  if (key.escape || (key.ctrl && input === "c")) {
    return "quit";
  }
  if (input === " ") {
    return "dismiss";
  }
  return ;
}

export function isComposerSoftLineBreakKeypress(
  input: string,
  key: { return?: boolean | undefined; shift?: boolean | undefined },
): boolean {
  return key.return === true && key.shift === true && input !== "\r" && input !== "\n";
}
