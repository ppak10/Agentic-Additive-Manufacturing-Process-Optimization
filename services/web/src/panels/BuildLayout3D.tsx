import { Suspense, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Edges, Text, Billboard } from "@react-three/drei";
import * as THREE from "three";
import type { PrintingObject } from "@/hooks/usePrintingObjects";
import type { ChamberSize } from "@/hooks/useChamber";
import { useMesh } from "@/hooks/useMesh";

// 3D phase-1 view: one box per PrintingObject, sized by mesh-local bounds,
// placed by the per-instance 4x4 transform. Chamber drawn as a wireframe.
// A semi-transparent plane indicates the current laser z-height. No real
// STL geometry yet — boxes only — but the spatial layout, exclusion state,
// hover/selection, and layer cursor are all visible.

// Helper: turn the API's row-major 4x4 transform into a THREE.Matrix4.
// THREE expects column-major in `.elements`, but `Matrix4.set(...)` takes
// row-major args, which is exactly what we have.
function rowMajorToMatrix4(rows: number[][]): THREE.Matrix4 {
  const [r0, r1, r2, r3] = rows;
  const m = new THREE.Matrix4();
  m.set(
    r0[0]!, r0[1]!, r0[2]!, r0[3]!,
    r1[0]!, r1[1]!, r1[2]!, r1[3]!,
    r2[0]!, r2[1]!, r2[2]!, r2[3]!,
    r3[0]!, r3[1]!, r3[2]!, r3[3]!,
  );
  return m;
}

// THE FIRMWARE'S TRANSFORM IS ROW-MAJOR AND APPLIES VECTORS AS V·M.
// THREE.js applies as M·V (column-major). So we need to transpose to get
// the same world placement. After transposing, decomposeable into position
// /quaternion/scale and applied to a Box centered on the mesh's local
// bounds center.
function buildInstanceMatrix(
  transform: number[][],
  boundsCenter: [number, number, number],
  boundsSize: [number, number, number],
): { matrix: THREE.Matrix4; size: [number, number, number] } {
  const wM = rowMajorToMatrix4(transform).transpose();
  // Translate the box geometry from origin-centered to mesh-local
  // bounds.Center before applying the world transform.
  const localT = new THREE.Matrix4().makeTranslation(boundsCenter[0], boundsCenter[1], boundsCenter[2]);
  return { matrix: wM.multiply(localT), size: boundsSize };
}

// World-placement matrix for a printing object (transposed API row-major →
// column-major, no local translation — the mesh's own vertices already sit
// in its local coordinate system). Exported for JobPreview3D, which renders
// stored-job instances in the same convention.
export function buildWorldMatrix(transform: number[][]): THREE.Matrix4 {
  return rowMajorToMatrix4(transform).transpose();
}

function ObjectMesh({
  obj,
  isSelected,
  isHovered,
  onSelect,
  onHover,
}: {
  obj: PrintingObject;
  isSelected: boolean;
  isHovered: boolean;
  onSelect: () => void;
  onHover: (hovering: boolean) => void;
}) {
  // Fetch the STL geometry for this hash. Returns null while loading;
  // during that window we fall back to the bounding box so there's still
  // something to click.
  const geometry = useMesh(obj.hash);
  const worldMatrix = useMemo(() => buildWorldMatrix(obj.transform), [obj.transform]);

  const color = obj.isExcluded ? "#666666" : isSelected ? "#ffffff" : isHovered ? "#ffb070" : "#ff7a05";
  const opacity = obj.isExcluded ? 0.35 : isSelected ? 0.9 : isHovered ? 0.8 : 0.7;
  const edgeColor = obj.isExcluded ? "#444" : isSelected ? "#fff" : "#000";

  const handlers = {
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onHover(true);
    },
    onPointerOut: () => onHover(false),
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onSelect();
    },
  };

  if (geometry) {
    return (
      // frustumCulled off — same reason as JobPreview3D's InstanceMesh:
      // manual matrices + culling make parts vanish at some camera poses
      <mesh geometry={geometry} matrix={worldMatrix} matrixAutoUpdate={false} frustumCulled={false} {...handlers}>
        <meshStandardMaterial color={color} transparent opacity={opacity} />
        {isSelected && <Edges color={edgeColor} />}
      </mesh>
    );
  }

  // Loading fallback: bounding box (same code path as phase 1). Skips
  // entirely if bounds haven't arrived yet either.
  if (!obj.bounds) return null;
  const { matrix, size } = buildInstanceMatrix(obj.transform, obj.bounds.center, obj.bounds.size);
  return (
    <mesh matrix={matrix} matrixAutoUpdate={false} frustumCulled={false} {...handlers}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} transparent opacity={0.3} wireframe />
    </mesh>
  );
}

// Side assignment for the chamber labels. Corrected per operator
// 2026-07-18: the recoater sweeps along X (was wrongly labeled on the Y
// faces) — powder feed on -X, overflow on +X. Flip these two values if
// the labels render on the wrong sides.
const POWDER_BIN_SIDE: "minX" | "maxX" | "minY" | "maxY" = "minX";
const OVERFLOW_SIDE: "minX" | "maxX" | "minY" | "maxY" = "maxX";

// Returns the centroid of a chamber face on the given side, plus an
// outward-pointing normal direction in chamber coords (origin at corner).
function faceCenter(
  side: "minX" | "maxX" | "minY" | "maxY",
  s: ChamberSize,
): { pos: [number, number, number]; normalAxis: "x" | "y"; normalSign: 1 | -1 } {
  const x = s.sizeX / 2;
  const y = s.sizeY / 2;
  const z = s.sizeZ / 2;
  switch (side) {
    case "minX": return { pos: [0, y, z], normalAxis: "x", normalSign: -1 };
    case "maxX": return { pos: [s.sizeX, y, z], normalAxis: "x", normalSign: 1 };
    case "minY": return { pos: [x, 0, z], normalAxis: "y", normalSign: -1 };
    case "maxY": return { pos: [x, s.sizeY, z], normalAxis: "y", normalSign: 1 };
  }
}

function SideLabel({
  text,
  color,
  side,
  chamber,
}: {
  text: string;
  color: string;
  side: "minX" | "maxX" | "minY" | "maxY";
  chamber: ChamberSize;
}) {
  // Place the label just OUTSIDE the chamber face — offset along the face
  // normal so the text doesn't z-fight with the wireframe and has a small
  // visual gap from the box edge.
  const face = faceCenter(side, chamber);
  const offset = Math.max(chamber.sizeX, chamber.sizeY) * 0.18;
  const labelPos: [number, number, number] = [
    face.pos[0] + (face.normalAxis === "x" ? face.normalSign * offset : 0),
    face.pos[1] + (face.normalAxis === "y" ? face.normalSign * offset : 0),
    face.pos[2],
  ];

  return (
    <Billboard position={labelPos}>
      <Text
        fontSize={Math.max(chamber.sizeX, chamber.sizeY) * 0.06}
        color={color}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.5}
        outlineColor="#000"
      >
        {text}
      </Text>
    </Billboard>
  );
}

export function Chamber({ size }: { size: ChamberSize }) {
  // Chamber is a wireframe box centered on (sizeX/2, sizeY/2, sizeZ/2) so
  // its origin corner matches the firmware's chamber origin at (0,0,0).
  // We center the geometry then translate to match.
  return (
    <>
      <mesh position={[size.sizeX / 2, size.sizeY / 2, size.sizeZ / 2]}>
        <boxGeometry args={[size.sizeX, size.sizeY, size.sizeZ]} />
        {/* depthWrite off: an invisible material still writes depth by
            default, and in the sorted transparent pass the box can draw
            before the parts inside it — occluding them entirely at some
            camera poses (same guard LayerPlane uses) */}
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        <Edges color="#888" />
      </mesh>
      <SideLabel text="Recoater" color="#7ad9ff" side={POWDER_BIN_SIDE} chamber={size} />
      <SideLabel text="Overflow" color="#ff7a05" side={OVERFLOW_SIDE} chamber={size} />
    </>
  );
}

function LayerPlane({ z, chamber }: { z: number; chamber: ChamberSize }) {
  // Semi-transparent quad spanning chamber XY at the current layer height.
  // Pure visual indicator — no clipping.
  return (
    <mesh position={[chamber.sizeX / 2, chamber.sizeY / 2, z]}>
      <planeGeometry args={[chamber.sizeX, chamber.sizeY]} />
      <meshBasicMaterial color="#ff7a05" transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

export function BuildLayout3D({
  chamber,
  printingObjects,
  layerZ,
  selectedId,
  hoveredId,
  onSelect,
  onHover,
}: {
  chamber: ChamberSize | null;
  printingObjects: PrintingObject[] | null;
  layerZ: number | null;
  selectedId: number | null;
  hoveredId: number | null;
  onSelect: (id: number) => void;
  onHover: (id: number | null) => void;
}) {
  // Frame the chamber in the camera roughly — printer chamber is ~161mm
  // cubed-ish, so a camera around (250, 250, 250) looking at the center
  // gives a reasonable orbit starting view.
  const cx = (chamber?.sizeX ?? 160) / 2;
  const cy = (chamber?.sizeY ?? 160) / 2;
  const cz = (chamber?.sizeZ ?? 200) / 2;
  const camRadius = Math.max(chamber?.sizeX ?? 160, chamber?.sizeY ?? 160, chamber?.sizeZ ?? 200) * 1.6;

  return (
    // Z-up to match the printer's coordinate system (firmware uses
    // chamber +Z = up). Three's default is Y-up, so we flip on the
    // <group rotation> below.
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
        {chamber && layerZ != null && <LayerPlane z={layerZ} chamber={chamber} />}
        {(printingObjects ?? []).map((obj) => (
          <ObjectMesh
            key={obj.id}
            obj={obj}
            isSelected={obj.id === selectedId}
            isHovered={obj.id === hoveredId}
            onSelect={() => onSelect(obj.id)}
            onHover={(h) => onHover(h ? obj.id : null)}
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
