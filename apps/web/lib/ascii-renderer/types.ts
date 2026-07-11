export type GlyphDefinition = {
  char: string;
  vector: number[];
};

export type AsciiFrameOptions = {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  fontFamily: string;
  fontPx: number;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type Face = [number, number, number];

export type MeshFace = {
  vertexIndices: [number, number, number];
  uvIndices: [number, number, number] | null;
};

export type Mesh = {
  vertices: Vec3[];
  uvs: Array<{ u: number; v: number }>;
  faces: MeshFace[];
};
