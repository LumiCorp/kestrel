import type { Mesh, MeshFace, Vec3 } from "./types";

function normalizeMesh(vertices: Vec3[]) {
  const bounds = vertices.reduce(
    (acc, vertex) => ({
      minX: Math.min(acc.minX, vertex.x),
      minY: Math.min(acc.minY, vertex.y),
      minZ: Math.min(acc.minZ, vertex.z),
      maxX: Math.max(acc.maxX, vertex.x),
      maxY: Math.max(acc.maxY, vertex.y),
      maxZ: Math.max(acc.maxZ, vertex.z),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      minZ: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      maxZ: Number.NEGATIVE_INFINITY,
    }
  );

  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };

  const size = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
    1
  );

  return vertices.map((vertex) => ({
    x: (vertex.x - center.x) / size,
    y: (vertex.y - center.y) / size,
    z: (vertex.z - center.z) / size,
  }));
}

export function parseObjMesh(source: string): Mesh {
  const vertices: Vec3[] = [];
  const uvs: Array<{ u: number; v: number }> = [];
  const faces: MeshFace[] = [];

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("v ")) {
      const [, x, y, z] = trimmed.split(/\s+/);
      vertices.push({
        x: Number.parseFloat(x),
        y: Number.parseFloat(y),
        z: Number.parseFloat(z),
      });
      continue;
    }

    if (trimmed.startsWith("vt ")) {
      const [, u, v] = trimmed.split(/\s+/);
      uvs.push({
        u: Number.parseFloat(u),
        v: Number.parseFloat(v),
      });
      continue;
    }

    if (trimmed.startsWith("f ")) {
      const parts = trimmed
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((part) => part.split("/"));

      if (parts.length < 3) {
        continue;
      }

      for (let index = 1; index < parts.length - 1; index += 1) {
        const tri = [parts[0], parts[index], parts[index + 1]];
        const vertexIndices = tri.map(
          (part) => Number.parseInt(part[0], 10) - 1
        ) as [number, number, number];
        const hasUvs = tri.every((part) => part[1]);
        const uvIndices = hasUvs
          ? (tri.map((part) => Number.parseInt(part[1], 10) - 1) as [
              number,
              number,
              number,
            ])
          : null;

        faces.push({ vertexIndices, uvIndices });
      }
    }
  }

  return {
    vertices: normalizeMesh(vertices),
    uvs,
    faces,
  };
}
