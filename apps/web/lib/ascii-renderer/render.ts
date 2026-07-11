import {
  createGlyphDatabase,
  findClosestGlyph,
  sampleCellVector,
} from "./glyphs";
import { renderTexturedMesh } from "./mesh";
import { parseObjMesh } from "./obj";
import { renderPlatonicSolid } from "./platonic";
import type { AsciiFrameOptions } from "./types";

export function generateAsciiFrames(
  options: AsciiFrameOptions & { frameCount: number }
) {
  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = options.cols * options.cellWidth;
  renderCanvas.height = options.rows * options.cellHeight;
  const renderContext = renderCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!renderContext) {
    throw new Error("2D canvas unavailable");
  }

  const glyphs = createGlyphDatabase({
    fontFamily: options.fontFamily,
    fontPx: options.fontPx,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
  });

  const frames: string[] = [];

  for (let frame = 0; frame < options.frameCount; frame += 1) {
    renderPlatonicSolid(
      renderContext,
      renderCanvas.width,
      renderCanvas.height,
      frame / options.frameCount
    );

    const imageData = renderContext.getImageData(
      0,
      0,
      renderCanvas.width,
      renderCanvas.height
    );

    const rows: string[] = [];

    for (let row = 0; row < options.rows; row += 1) {
      let line = "";

      for (let col = 0; col < options.cols; col += 1) {
        const vector = sampleCellVector({
          imageData,
          x: col * options.cellWidth,
          y: row * options.cellHeight,
          width: options.cellWidth,
          height: options.cellHeight,
        });

        line += findClosestGlyph(glyphs, vector);
      }

      rows.push(line);
    }

    frames.push(rows.join("\n"));
  }

  return frames;
}

export async function generateObjAsciiFrames(
  options: AsciiFrameOptions & {
    frameCount: number;
    objUrl: string;
    textureUrl: string;
  }
) {
  const [objSource, textureImage] = await Promise.all([
    fetch(options.objUrl).then((response) => response.text()),
    loadImage(options.textureUrl),
  ]);

  const mesh = parseObjMesh(objSource);
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = textureImage.naturalWidth;
  textureCanvas.height = textureImage.naturalHeight;
  const textureContext = textureCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!textureContext) {
    throw new Error("2D canvas unavailable");
  }

  textureContext.drawImage(textureImage, 0, 0);
  const texture = textureContext.getImageData(
    0,
    0,
    textureCanvas.width,
    textureCanvas.height
  );

  const renderCanvas = document.createElement("canvas");
  renderCanvas.width = options.cols * options.cellWidth;
  renderCanvas.height = options.rows * options.cellHeight;
  const renderContext = renderCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!renderContext) {
    throw new Error("2D canvas unavailable");
  }

  const glyphs = createGlyphDatabase({
    fontFamily: options.fontFamily,
    fontPx: options.fontPx,
    cellWidth: options.cellWidth,
    cellHeight: options.cellHeight,
  });

  const frames: string[] = [];

  for (let frame = 0; frame < options.frameCount; frame += 1) {
    renderTexturedMesh({
      context: renderContext,
      width: renderCanvas.width,
      height: renderCanvas.height,
      phase: frame / options.frameCount,
      mesh,
      texture,
    });

    const imageData = renderContext.getImageData(
      0,
      0,
      renderCanvas.width,
      renderCanvas.height
    );

    const rows: string[] = [];

    for (let row = 0; row < options.rows; row += 1) {
      let line = "";

      for (let col = 0; col < options.cols; col += 1) {
        const vector = sampleCellVector({
          imageData,
          x: col * options.cellWidth,
          y: row * options.cellHeight,
          width: options.cellWidth,
          height: options.cellHeight,
        });

        line += findClosestGlyph(glyphs, vector);
      }

      rows.push(line);
    }

    frames.push(rows.join("\n"));
  }

  return frames;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}
