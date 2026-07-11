import { getStorageAdapter } from "@/lib/storage";

export async function saveUpload(input: {
  pathname: string[];
  buffer: Buffer;
  contentType?: string;
}) {
  const storage = getStorageAdapter();
  const key = storage.buildObjectKey("chat-uploads", ...input.pathname);
  await storage.putObject({
    key,
    body: input.buffer,
    contentType: input.contentType,
  });

  return {
    pathname: input.pathname.join("/"),
    fullPath: key,
  };
}

export async function readUpload(pathname: string[]) {
  const storage = getStorageAdapter();
  const fullPath = storage.buildObjectKey("chat-uploads", ...pathname);
  const buffer = await storage.getObjectBuffer(fullPath);
  return {
    buffer,
    size: buffer.length,
    fullPath,
  };
}

export async function deleteUpload(pathname: string[]) {
  const storage = getStorageAdapter();
  const fullPath = storage.buildObjectKey("chat-uploads", ...pathname);
  await storage.deleteObject(fullPath);
}
