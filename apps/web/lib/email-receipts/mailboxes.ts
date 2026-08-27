import emailAddresses from "email-addresses";
import {
  EMAIL_MAILBOX_LIST_MAX_COUNT,
  EMAIL_MAILBOX_MAX_LENGTH,
} from "./bounds";

export function parseExactlyOneMailbox(value: string) {
  const addresses = parseMailboxFields([value]);
  if (addresses.length !== 1) throw new Error("Expected one mailbox.");
  const address = addresses[0];
  if (!address) throw new Error("Expected one mailbox.");
  return address;
}

export function parseMailboxFields(values: readonly string[]) {
  if (values.length > EMAIL_MAILBOX_LIST_MAX_COUNT) {
    throw new Error("Mailbox list is out of bounds.");
  }
  const parsed: string[] = [];
  for (const value of values) {
    if (value.length > EMAIL_MAILBOX_MAX_LENGTH) {
      throw new Error("Mailbox is out of bounds.");
    }
    const entries = emailAddresses.parseAddressList({
      input: value,
      strict: true,
      rfc6532: true,
    });
    if (!entries?.length) throw new Error("Mailbox is malformed.");
    for (const entry of entries) {
      const mailboxes = entry.type === "group" ? entry.addresses : [entry];
      if (mailboxes.length === 0) throw new Error("Mailbox group is empty.");
      for (const mailbox of mailboxes) {
        parsed.push(normalizeMailbox(mailbox.local, mailbox.domain));
      }
    }
  }
  if (parsed.length > EMAIL_MAILBOX_LIST_MAX_COUNT) {
    throw new Error("Mailbox list is out of bounds.");
  }
  return parsed;
}

export function normalizeMailbox(local: string, domain: string) {
  const address = `${local}@${domain}`.toLowerCase();
  if (address.length > EMAIL_MAILBOX_MAX_LENGTH) {
    throw new Error("Mailbox is out of bounds.");
  }
  return address;
}
