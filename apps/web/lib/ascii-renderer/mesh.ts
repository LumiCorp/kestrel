import type { Mesh, Vec3 } from "./types";

function rotate(vertex: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);

  const yawed = {
    x: vertex.x * cosY - vertex.z * sinY,
    y: vertex.y,
    z: vertex.x * sinY + vertex.z * cosY,
  };

  const pitched = {
    x: yawed.x,
    y: yawed.y * cosP - yawed.z * sinP,
    z: yawed.y * sinP + yawed.z * cosP,
  };

  return {
    x: pitched.x * cosR - pitched.y * sinR,
    y: pitched.x * sinR + pitched.y * cosR,
    z: pitched.z,
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function sampleTextureLuminance(imageData: ImageData, u: number, v: number) {
  const x = Math.max(
    0,
    Math.min(imageData.width - 1, Math.round(u * (imageData.width - 1)))
  );
  const y = Math.max(
    0,
    Math.min(imageData.height - 1, Math.round((1 - v) * (imageData.height - 1)))
  );
  const index = (y * imageData.width + x) * 4;
  const r = imageData.data[index] / 255;
  const g = imageData.data[index + 1] / 255;
  const b = imageData.data[index + 2] / 255;

  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function renderTexturedMesh(options: {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  phase: number;
  mesh: Mesh;
  texture: ImageData;
}) {
  const { context, width, height, phase, mesh, texture } = options;

  context.clearRect(0, 0, width, height);
  context.fillStyle = "black";
  context.fillRect(0, 0, width, height);

  const yaw = phase * Math.PI * 2;
  const pitch = Math.sin(phase * Math.PI * 2) * 0.16 + 0.2;
  const roll = phase * Math.PI * 0.08;

  const rotated = mesh.vertices.map((vertex) =>
    rotate(vertex, yaw, pitch, roll)
  );
  const projected = rotated.map((vertex) => {
    const depth = vertex.z + 3.35;
    const scale = 2.75 / depth;
    return {
      x: width * 0.5 + vertex.x * scale * width * 0.8,
      y:
        height * 0.58 +
        (-vertex.y + Math.sin(phase * Math.PI * 2) * 0.02) *
          scale *
          height *
          0.92,
      z: depth,
    };
  });

  const light = normalize({ x: -0.3, y: -0.55, z: 1 });

  const faces = mesh.faces
    .map((face) => {
      const [aIndex, bIndex, cIndex] = face.vertexIndices;
      const a = rotated[aIndex];
      const b = rotated[bIndex];
      const c = rotated[cIndex];
      const normal = normalize(cross(subtract(b, a), subtract(c, a)));
      const visibility = normal.z;
      const shade = Math.max(0, dot(normal, light));

      let textureLight = 0.68;

      if (face.uvIndices) {
        const [uaIndex, ubIndex, ucIndex] = face.uvIndices;
        const ua = mesh.uvs[uaIndex];
        const ub = mesh.uvs[ubIndex];
        const uc = mesh.uvs[ucIndex];

        textureLight = sampleTextureLuminance(
          texture,
          (ua.u + ub.u + uc.u) / 3,
          (ua.v + ub.v + uc.v) / 3
        );
      }

      return {
        face,
        depth:
          (projected[aIndex].z + projected[bIndex].z + projected[cIndex].z) / 3,
        shade,
        visibility,
        textureLight,
      };
    })
    .filter((face) => face.visibility > -0.18)
    .sort((left, right) => right.depth - left.depth);

  context.lineJoin = "round";

  for (const entry of faces) {
    const [aIndex, bIndex, cIndex] = entry.face.vertexIndices;
    const a = projected[aIndex];
    const b = projected[bIndex];
    const c = projected[cIndex];
    const lit = 0.18 + entry.shade * 0.68;
    const textureWeight = 0.74 + (1 - entry.textureLight) * 0.18;
    const textured = lit * textureWeight;
    const faceLight = Math.round(
      Math.max(0.16, Math.min(0.66, textured)) * 255
    );
    const edgeLight = Math.min(255, faceLight + 28);

    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.lineTo(c.x, c.y);
    context.closePath();
    context.fillStyle = `rgb(${faceLight}, ${faceLight}, ${faceLight})`;
    context.fill();
    context.strokeStyle = `rgba(${edgeLight}, ${edgeLight}, ${edgeLight}, 0.92)`;
    context.lineWidth = Math.max(1.1, width / 260);
    context.stroke();
  }
}
