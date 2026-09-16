import * as THREE from 'three';
import type { FramePair } from './sky-stream';

/**
 * Which object is under the pointer.
 *
 * Picking reads the SAME blend the GPU is drawing - the two ticks either side of
 * scene time, mixed and renormalised exactly as BLEND_GLSL does - so the ring lands
 * on the object where it actually appears on screen, not where it was at the last
 * tick. At the top of the rate ladder a tick spans ten scene seconds; picking the raw
 * tick would miss by degrees.
 *
 * Only objects above the horizon can be picked. Below-horizon objects are drawn, but
 * they are on the other side of the world: nothing about them is available to the eye,
 * and a mark on one could never enter the readout, which lists what is overhead.
 *
 * Cost is one screen-space projection per object above the horizon - the few percent
 * of the catalogue that are up, ~1500 of 21k - and it runs at most once per rendered
 * frame. The rest fall out on a sign test.
 */
const blended = new THREE.Vector3();
const viewProjection = new THREE.Matrix4();
const forward = new THREE.Vector3();

export interface PickTarget {
  camera: THREE.PerspectiveCamera;
  /** Canvas size in CSS pixels, and its position in the viewport. */
  rect: DOMRect;
}

export function pickNearest(
  { camera, rect }: PickTarget,
  pair: FramePair,
  clientX: number,
  clientY: number,
  radiusPx: number
): number {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return -1;

  camera.updateMatrixWorld();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  camera.getWorldDirection(forward);

  const { from, to, t } = pair;
  const a = from.direction;
  const b = to.direction;
  // A recycled frame's buffer has been transferred back to the worker and is empty.
  if (a.length === 0 || b.length === 0) return -1;
  const count = Math.min(from.count, to.count);

  let best = -1;
  let bestDistSq = radiusPx * radiusPx;

  for (let i = 0; i < count; i++) {
    if (from.range[i]! < 0 || to.range[i]! < 0) continue;

    const j = i * 3;
    const dy = a[j + 1]! + (b[j + 1]! - a[j + 1]!) * t;
    if (dy <= 0) continue; // below the horizon

    const dx = a[j]! + (b[j]! - a[j]!) * t;
    const dz = a[j + 2]! + (b[j + 2]! - a[j + 2]!) * t;

    // Behind the camera: projecting it would fold it onto the screen upside down.
    if (dx * forward.x + dy * forward.y + dz * forward.z <= 0) continue;

    // Any positive multiple of the direction projects to the same pixel, so the
    // unnormalised blend is enough here - the renormalise only matters for length.
    blended.set(dx, dy, dz).applyMatrix4(viewProjection);
    const sx = (blended.x * 0.5 + 0.5) * rect.width;
    const sy = (-blended.y * 0.5 + 0.5) * rect.height;

    const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
    if (d < bestDistSq) {
      bestDistSq = d;
      best = i;
    }
  }

  return best;
}
