export const DESKTOP_ASSETS = Object.freeze([
  "exports/kestrel-app-icon-light.png",
  "exports/kestrel-app-icon-light.icns",
  "exports/kestrel-app-icon-light.ico",
]);

export function desktopAssetName(source) {
  return source.split("/").at(-1);
}
