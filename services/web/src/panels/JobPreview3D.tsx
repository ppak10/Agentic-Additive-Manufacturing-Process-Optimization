import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { buildWorldMatrix, Chamber } from "@/panels/BuildLayout3D";
import type { ChamberSize } from "@/hooks/useChamber";
import type { JobInstance } from "@/hooks/useJobInstances";
import { useMesh } from "@/hooks/useMesh";

// 3D preview of a STORED job (Jobs page detail card) — the off-print
// sibling of BuildLayout3D: same chamber wireframe, same V·M row-major
// transform convention, but sourced from /api/jobs/:id/instances +
// /api/jobs/:id/meshes/:hash instead of the live print stream.

function InstanceMesh({
  inst,
  jobId,
  isSelected,
  onSelect,
}: {
  inst: JobInstance;
  jobId: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const geometry = useMesh(inst.hash, jobId);
  // MeshPrintTransform applies to the firmware's PROCESSED mesh, which is
  // recentered on its bounds — raw STL coordinates need the same recentering
  // before the world transform or every instance lands offset by its own
  // bounds center (clipping outside the chamber).
  const matrix = useMemo(() => {
    if (!geometry) return null;
    geometry.computeBoundingBox();
    const c = geometry.boundingBox!.getCenter(new THREE.Vector3());
    return buildWorldMatrix(inst.transform)
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  }, [geometry, inst.transform]);
  // No bounds in the stored-instance payload, so no box fallback — meshes
  // are small (~30 KB) and pop in quickly.
  if (!geometry || !matrix) return null;
  return (
    // frustumCulled off: with a hand-composed matrix (matrixAutoUpdate
    // false) the culler tests a bounding sphere against a matrixWorld that
    // isn't reliably refreshed, making parts vanish at certain camera
    // distances/rotations. ~14 small meshes — culling buys nothing here.
    <mesh
      geometry={geometry}
      matrix={matrix}
      matrixAutoUpdate={false}
      frustumCulled={false}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {/* opaque on purpose: transparent parts join the depth-sorted pass,
          where sort order flips with camera angle and neighbors occlude
          each other inconsistently */}
      <meshStandardMaterial color={isSelected ? "#ff7a05" : "#9ca3af"} />
    </mesh>
  );
}

// Whole-build view: chamber wireframe + every nested instance. Clicking an
// instance selects its object file (all instances of that file highlight).
export function JobBuild3D({
  jobId,
  chamber,
  instances,
  selectedHash,
  onSelectHash,
}: {
  jobId: string;
  chamber: ChamberSize | null;
  instances: JobInstance[];
  selectedHash: string | null;
  onSelectHash: (hash: string) => void;
}) {
  // Same framing as BuildLayout3D: Z-up to match the printer's coords.
  const cx = (chamber?.sizeX ?? 160) / 2;
  const cy = (chamber?.sizeY ?? 160) / 2;
  const cz = (chamber?.sizeZ ?? 200) / 2;
  const camRadius = Math.max(chamber?.sizeX ?? 160, chamber?.sizeY ?? 160, chamber?.sizeZ ?? 200) * 1.6;

  return (
    <Canvas
      camera={{
        position: [cx + camRadius * 0.8, cy - camRadius * 0.6, cz + camRadius * 0.5],
        fov: 35,
        near: 1,
        far: camRadius * 10,
        up: [0, 0, 1],
      }}
      dpr={[1, 2]}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[200, 200, 400]} intensity={0.8} />
      <directionalLight position={[-200, -200, 200]} intensity={0.3} />
      <Suspense fallback={null}>
        {chamber && <Chamber size={chamber} />}
        {instances.map((inst) => (
          <InstanceMesh
            key={inst.id}
            inst={inst}
            jobId={jobId}
            isSelected={inst.hash === selectedHash}
            onSelect={() => onSelectHash(inst.hash)}
          />
        ))}
      </Suspense>
      <OrbitControls
        target={[cx, cy, cz]}
        enableDamping
        dampingFactor={0.1}
        minDistance={camRadius * 0.2}
        maxDistance={camRadius * 4}
      />
    </Canvas>
  );
}

// Single-part viewer: the selected object file's mesh centered on the
// origin, camera distance scaled to the part's bounding sphere.
export function PartViewer3D({ jobId, hash }: { jobId: string; hash: string | null }) {
  const geometry = useMesh(hash, jobId);

  const view = useMemo(() => {
    if (!geometry) return null;
    geometry.computeBoundingSphere();
    const s = geometry.boundingSphere;
    if (!s) return null;
    return { center: s.center, radius: Math.max(s.radius, 1) };
  }, [geometry]);

  if (!hash) {
    return <div className="p-3 text-xs opacity-50">Select a part below.</div>;
  }
  if (!geometry || !view) {
    return <div className="p-3 text-xs opacity-50">loading mesh…</div>;
  }

  const r = view.radius;
  return (
    // key on hash: re-mount per part so the radius-scaled camera resets
    <Canvas
      key={hash}
      camera={{
        position: [r * 2, -r * 2, r * 1.5],
        fov: 35,
        near: r / 50,
        far: r * 20,
        up: [0, 0, 1],
      }}
      dpr={[1, 2]}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[200, 200, 400]} intensity={0.8} />
      <directionalLight position={[-200, -200, 200]} intensity={0.3} />
      <mesh geometry={geometry} position={[-view.center.x, -view.center.y, -view.center.z]}>
        <meshStandardMaterial color="#ff7a05" />
      </mesh>
      <OrbitControls
        target={[0, 0, 0]}
        enableDamping
        dampingFactor={0.1}
        minDistance={r * 0.5}
        maxDistance={r * 8}
      />
    </Canvas>
  );
}
