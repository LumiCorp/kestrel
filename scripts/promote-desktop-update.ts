import { parseDesktopUpdateChannel } from "../apps/desktop/src/builderConfig.js";
import { createDesktopUpdateR2StoreFromEnvironment } from "./desktop-update-r2-store.js";
import {
  parseDesktopUpdatePromotionVersion,
  promoteDesktopUpdateRelease,
} from "./desktop-update-publisher.js";

if (process.env.KESTREL_DESKTOP_PROMOTION_APPROVED !== "1") {
  throw new Error(
    "Desktop channel promotion requires explicit approval. "
      + "Set KESTREL_DESKTOP_PROMOTION_APPROVED=1 for one supervised promotion.",
  );
}

const version = parseDesktopUpdatePromotionVersion(process.argv.slice(2));
const channel = parseDesktopUpdateChannel(
  process.env.KESTREL_DESKTOP_UPDATE_CHANNEL,
);
const { store, prefix } = createDesktopUpdateR2StoreFromEnvironment();
const result = await promoteDesktopUpdateRelease({
  version,
  channel,
  store,
  prefix,
});
process.stdout.write(
  `[desktop-update-promotion] version=${version} channel=${channel} promoted=${
    result.promotedMetadataKey
  } source=${result.releaseMetadataKey} alreadyCurrent=${String(
    result.alreadyCurrent,
  )} previousEtag=${result.previousMetadataEtag ?? "none"}\n`,
);
