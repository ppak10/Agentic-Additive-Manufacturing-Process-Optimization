import { useEffect, useState } from "react";
import * as THREE from "three";

// Fetches a printing object's mesh (binary blob from /api/printing/meshes/{hash})
// and parses it into a shared Three.js BufferGeometry, cached per hash so
// every instance of the same STL reuses one geometry (crucial when the same
// mesh has 8+ instances in a nest).

const geometryCache = new Map<string, THREE.BufferGeometry>();
const inflight = new Map<string, Promise<THREE.BufferGeometry | null>>();

// Format matches the plugin's writer:
//   uint32 magic 0x4853454D ("MESH")
//   uint32 version = 1
//   uint32 vertexCount
//   uint32 indexCount
//   uint32 flags (bit 0: hasNormals)
//   float32[vertexCount * 3] vertices
//   uint32 [indexCount]      indices
//   float32[vertexCount * 3] normals (only if hasNormals)
function parseMeshBlob(buf: ArrayBuffer): THREE.BufferGeometry | null {
  const dv = new DataView(buf);
  if (buf.byteLength < 20) return null;
  const magic = dv.getUint32(0, true);
  if (magic !== 0x4853454d) return null; // "MESH"
  const version = dv.getUint32(4, true);
  if (version !== 1) return null;
  const vertexCount = dv.getUint32(8, true);
  const indexCount = dv.getUint32(12, true);
  const flags = dv.getUint32(16, true);
  const hasNormals = (flags & 1) !== 0;

  let offset = 20;
  const verts = new Float32Array(buf, offset, vertexCount * 3);
  offset += vertexCount * 12;
  const indices = new Uint32Array(buf, offset, indexCount);
  offset += indexCount * 4;
  const normals = hasNormals ? new Float32Array(buf, offset, vertexCount * 3) : null;

  const geo = new THREE.BufferGeometry();
  // Copy the typed arrays — the underlying ArrayBuffer is a view into the
  // fetch response and could get GC'd out from under Three.js otherwise.
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  if (normals) {
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  } else {
    geo.computeVertexNormals();
  }
  geo.computeBoundingSphere();
  return geo;
}

async function fetchMesh(hash: string, url: string): Promise<THREE.BufferGeometry | null> {
  const cached = geometryCache.get(hash);
  if (cached) return cached;
  const pending = inflight.get(hash);
  if (pending) return pending;
  const p = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = await r.arrayBuffer();
      const geo = parseMeshBlob(buf);
      if (geo) geometryCache.set(hash, geo);
      return geo;
    } catch {
      return null;
    } finally {
      inflight.delete(hash);
    }
  })();
  inflight.set(hash, p);
  return p;
}

// Returns the parsed geometry for a mesh hash, or null while loading /
// unavailable. Renders are stable — same hash → same geometry object,
// safe to pass to Three.js meshes directly.
//
// Without jobId the hash resolves via the live-print route
// (/api/printing/meshes, mid-print only); with jobId it resolves via the
// stored-job route (/api/jobs/:id/meshes), which works while idle. The
// cache is keyed by hash alone — it's a content address, so both routes
// return identical geometry.
export function useMesh(hash: string | null, jobId?: string): THREE.BufferGeometry | null {
  const [geo, setGeo] = useState<THREE.BufferGeometry | null>(() =>
    hash ? geometryCache.get(hash) ?? null : null,
  );

  useEffect(() => {
    if (!hash) {
      setGeo(null);
      return;
    }
    const cached = geometryCache.get(hash);
    if (cached) {
      setGeo(cached);
      return;
    }
    const url = jobId
      ? `/api/jobs/${encodeURIComponent(jobId)}/meshes/${encodeURIComponent(hash)}`
      : `/api/printing/meshes/${encodeURIComponent(hash)}`;
    let cancelled = false;
    void fetchMesh(hash, url).then((g) => {
      if (!cancelled) setGeo(g);
    });
    return () => {
      cancelled = true;
    };
  }, [hash, jobId]);

  return geo;
}
