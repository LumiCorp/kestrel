/** Parse the exact Node platform values accepted by Local Core. */
export function parseLocalCorePlatform(
  value: string | undefined,
): NodeJS.Platform | undefined {
  switch (value) {
    case "aix":
    case "android":
    case "cygwin":
    case "darwin":
    case "freebsd":
    case "haiku":
    case "linux":
    case "netbsd":
    case "openbsd":
    case "sunos":
    case "win32":
      return value;
    default:
      return ;
  }
}
