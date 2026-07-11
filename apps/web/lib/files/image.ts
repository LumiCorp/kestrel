import sharp from "sharp";

const DEFAULT_MAX_WIDTH = 1536;
const DEFAULT_MAX_HEIGHT = 1536;
const DEFAULT_QUALITY = 85;

export function isOptimizableImage(contentType: string) {
  return contentType.startsWith("image/");
}

export async function optimizeImage(input: Buffer) {
  const metadata = await sharp(input).metadata();
  const width = metadata.width || DEFAULT_MAX_WIDTH;
  const height = metadata.height || DEFAULT_MAX_HEIGHT;

  let pipeline = sharp(input);

  if (width > DEFAULT_MAX_WIDTH || height > DEFAULT_MAX_HEIGHT) {
    pipeline = pipeline.resize(DEFAULT_MAX_WIDTH, DEFAULT_MAX_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const buffer = await pipeline
    .rotate()
    .jpeg({ quality: DEFAULT_QUALITY, mozjpeg: true })
    .toBuffer();

  return {
    buffer,
    contentType: "image/jpeg",
    extension: ".jpg",
  };
}
