import type { GlyphDefinition } from "./types";

const GLYPHS =
  " .'`^\",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";

const REGION_OFFSETS = [
  { x: 0.24, y: 0.24, radius: 0.18 },
  { x: 0.5, y: 0.18, radius: 0.16 },
  { x: 0.76, y: 0.24, radius: 0.18 },
  { x: 0.28, y: 0.58, radius: 0.2 },
  { x: 0.72, y: 0.58, radius: 0.2 },
  { x: 0.5, y: 0.82, radius: 0.18 },
];

function buildCircleSamples(
  size: { width: number; height: number },
  region: { x: number; y: number; radius: number }
) {
  const samples: Array<{ x: number; y: number }> = [];
  const centerX = region.x * size.width;
  const centerY = region.y * size.height;
  const radius = region.radius * Math.min(size.width, size.height);

  for (let y = -radius; y <= radius; y += Math.max(1, radius / 4)) {
    for (let x = -radius; x <= radius; x += Math.max(1, radius / 4)) {
      if (x * x + y * y <= radius * radius) {
        samples.push({ x: centerX + x, y: centerY + y });
      }
    }
  }

  return samples;
}

function sampleRegion(
  imageData: ImageData,
  samples: Array<{ x: number; y: number }>
) {
  let total = 0;

  for (const sample of samples) {
    const x = Math.max(0, Math.min(imageData.width - 1, Math.round(sample.x)));
    const y = Math.max(0, Math.min(imageData.height - 1, Math.round(sample.y)));
    const index = (y * imageData.width + x) * 4;
    total += imageData.data[index] / 255;
  }

  return total / samples.length;
}

export function createGlyphDatabase(options: {
  fontFamily: string;
  fontPx: number;
  cellWidth: number;
  cellHeight: number;
}) {
  const canvas = document.createElement("canvas");
  canvas.width = options.cellWidth;
  canvas.height = options.cellHeight;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D canvas unavailable");
  }

  const regionSamples = REGION_OFFSETS.map((region) =>
    buildCircleSamples({ width: canvas.width, height: canvas.height }, region)
  );

  const glyphs: GlyphDefinition[] = [];

  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const char of GLYPHS) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "black";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "white";
    context.font = `${options.fontPx}px ${options.fontFamily}`;
    context.fillText(char, canvas.width / 2, canvas.height / 2 + 0.5);

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const vector = regionSamples.map((samples) =>
      sampleRegion(imageData, samples)
    );

    glyphs.push({ char, vector });
  }

  const maxByRegion = regionSamples.map((_, index) =>
    Math.max(...glyphs.map((glyph) => glyph.vector[index]), 1)
  );

  return glyphs.map((glyph) => ({
    char: glyph.char,
    vector: glyph.vector.map((value, index) => value / maxByRegion[index]),
  }));
}

export function sampleCellVector(options: {
  imageData: ImageData;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const regionSamples = REGION_OFFSETS.map((region) =>
    buildCircleSamples({ width: options.width, height: options.height }, region)
  );

  const vector = regionSamples.map((samples) => {
    let total = 0;

    for (const sample of samples) {
      const px = Math.max(
        0,
        Math.min(options.imageData.width - 1, Math.round(options.x + sample.x))
      );
      const py = Math.max(
        0,
        Math.min(options.imageData.height - 1, Math.round(options.y + sample.y))
      );
      const index = (py * options.imageData.width + px) * 4;
      total += options.imageData.data[index] / 255;
    }

    return total / samples.length;
  });

  const average = vector.reduce((sum, value) => sum + value, 0) / vector.length;
  const boosted = vector.map((value) =>
    Math.max(0, Math.min(1, average + (value - average) * 1.35))
  );

  return boosted;
}

export function findClosestGlyph(glyphs: GlyphDefinition[], vector: number[]) {
  const average = vector.reduce((sum, value) => sum + value, 0) / vector.length;

  if (average < 0.03) {
    return " ";
  }

  let bestGlyph = glyphs[0]?.char ?? " ";
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const glyph of glyphs) {
    let distance = 0;
    const glyphAverage =
      glyph.vector.reduce((sum, value) => sum + value, 0) / glyph.vector.length;

    for (let index = 0; index < glyph.vector.length; index += 1) {
      const diff = glyph.vector[index] - vector[index];
      distance += diff * diff;
    }

    distance += Math.abs(glyphAverage - average) * 0.45;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestGlyph = glyph.char;
    }
  }

  return bestGlyph;
}
