import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const outputPath = process.argv[2]?.trim();
if (!outputPath) {
  throw new Error("Local Environment ticket key path is required.");
}

await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });

if (!(await hasUsableKeys(outputPath))) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = JSON.stringify({
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, outputPath);
}

await chmod(outputPath, 0o600);

async function hasUsableKeys(filePath: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      privateKey?: unknown;
      publicKey?: unknown;
    };
    if (
      typeof parsed.privateKey !== "string" ||
      typeof parsed.publicKey !== "string"
    ) {
      return false;
    }
    const derivedPublicKey = createPublicKey(createPrivateKey(parsed.privateKey))
      .export({ type: "spki", format: "der" });
    const storedPublicKey = createPublicKey(parsed.publicKey).export({
      type: "spki",
      format: "der",
    });
    return derivedPublicKey.equals(storedPublicKey);
  } catch {
    return false;
  }
}
