import type { Face, Vec3 } from "./types";

const VERTICES: Vec3[] = [
  { x: 1, y: 1, z: 1 },
  { x: -1, y: -1, z: 1 },
  { x: -1, y: 1, z: -1 },
  { x: 1, y: -1, z: -1 },
].map((vertex) => {
  const length = Math.hypot(vertex.x, vertex.y, vertex.z);

  return {
    x: vertex.x / length,
    y: vertex.y / length,
    z: vertex.z / length,
  };
});

const FACES: Face[] = [
  [0, 1, 2],
  [0, 3, 1],
  [0, 2, 3],
  [1, 3, 2],
];

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

export function renderPlatonicSolid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  phase: number
) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "black";
  context.fillRect(0, 0, width, height);

  const yaw = phase * Math.PI * 2;
  const pitch = Math.sin(phase * Math.PI * 2) * 0.28 + 0.38;
  const roll = phase * Math.PI * 0.2;

  const rotated = VERTICES.map((vertex) => rotate(vertex, yaw, pitch, roll));
  const projected = rotated.map((vertex) => {
    const depth = vertex.z + 3.2;
    const scale = 2.7 / depth;
    return {
      x: width * 0.52 + vertex.x * scale * width * 0.56,
      y:
        height * 0.5 +
        (vertex.y + Math.sin(phase * Math.PI * 2) * 0.035) *
          scale *
          height *
          0.56,
      z: depth,
    };
  });

  const light = normalize({ x: -0.45, y: -0.65, z: 1 });

  const faces = FACES.map((face) => {
    const [aIndex, bIndex, cIndex] = face;
    const a = rotated[aIndex];
    const b = rotated[bIndex];
    const c = rotated[cIndex];
    const normal = normalize(cross(subtract(b, a), subtract(c, a)));
    const visibility = normal.z;
    const shade = Math.max(0, dot(normal, light));

    return {
      face,
      depth:
        (projected[aIndex].z + projected[bIndex].z + projected[cIndex].z) / 3,
      shade,
      visibility,
    };
  })
    .filter((face) => face.visibility > -0.08)
    .sort((left, right) => right.depth - left.depth);

  context.lineJoin = "round";

  for (const entry of faces) {
    const [aIndex, bIndex, cIndex] = entry.face;
    const a = projected[aIndex];
    const b = projected[bIndex];
    const c = projected[cIndex];
    const faceShade = 0.1 + entry.shade * 0.9;
    const faceLight = Math.round(faceShade * 255);
    const edgeLight = Math.min(255, faceLight + 54);

    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.lineTo(c.x, c.y);
    context.closePath();
    context.fillStyle = `rgb(${faceLight}, ${faceLight}, ${faceLight})`;
    context.fill();
    context.strokeStyle = `rgba(${edgeLight}, ${edgeLight}, ${edgeLight}, 0.9)`;
    context.lineWidth = Math.max(1.2, width / 250);
    context.stroke();
  }
}
