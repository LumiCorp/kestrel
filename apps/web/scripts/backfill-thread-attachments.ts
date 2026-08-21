import { backfillLegacyThreadAttachments } from "../lib/attachments/backfill";

const result = await backfillLegacyThreadAttachments(10_000);
console.log(JSON.stringify(result));
