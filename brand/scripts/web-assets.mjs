export const WEB_ASSETS = Object.freeze([
  "masters/kestrel-mark-black.svg",
  "masters/kestrel-mark-white.svg",
  "masters/kestrel-one-lockup-black.svg",
  "masters/kestrel-one-lockup-white.svg",
  "exports/favicon-light-16.png",
  "exports/favicon-light-32.png",
  "exports/favicon-light-180.png",
  "exports/favicon-light-192.png",
  "exports/favicon-light-512.png",
  "exports/favicon-light.ico",
  "exports/favicon-dark-16.png",
  "exports/favicon-dark-32.png",
  "exports/favicon-dark-180.png",
  "exports/favicon-dark-192.png",
  "exports/favicon-dark-512.png",
  "exports/favicon-dark.ico",
  "exports/kestrel-one-social-card.png",
]);

export function webAssetName(source) {
  return source.split("/").at(-1);
}
