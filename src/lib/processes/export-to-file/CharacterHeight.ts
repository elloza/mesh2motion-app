import { Box3, type Object3D, type SkinnedMesh } from 'three'

// height of the Unreal Engine mannequins (Manny / Quinn); generated models are often
// normalized to about 1 m, which looks like a child next to the default capsule
export const DEFAULT_CHARACTER_HEIGHT_M: number = 1.8
export const MIN_CHARACTER_HEIGHT_M: number = 0.1
export const MAX_CHARACTER_HEIGHT_M: number = 20

/**
 * Height (Y extent) of the skinned meshes under the given objects in world space, in meters.
 * Measured from the raw geometry, which for skinned meshes is the bind pose, so
 * the animation frame on screen (crouching, jumping...) does not change it.
 */
export function measure_character_height (objects: Object3D[]): number {
  const bounds = new Box3()
  const mesh_bounds = new Box3()
  objects.forEach((root) => {
    root.updateWorldMatrix(true, true)
    root.traverse((object) => {
      // only the body: props held in the hands hang from the bones and are not part of the height
      const mesh = object as SkinnedMesh
      if (mesh.isSkinnedMesh !== true || mesh.geometry === undefined) { return }
      if (mesh.geometry.boundingBox === null) { mesh.geometry.computeBoundingBox() }
      if (mesh.geometry.boundingBox === null) { return }
      mesh_bounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
      bounds.union(mesh_bounds)
    })
  })
  return bounds.isEmpty() ? 0 : bounds.max.y - bounds.min.y
}

/**
 * Uniform factor that turns the measured height into the target height.
 * 1 when there is no valid target or nothing to measure.
 */
export function character_size_factor (target_height: number | null, measured_height: number): number {
  if (target_height === null || !Number.isFinite(target_height) || target_height <= 0) { return 1 }
  if (!Number.isFinite(measured_height) || measured_height <= 1e-6) { return 1 }
  return target_height / measured_height
}

export function is_valid_character_height (value: number): boolean {
  return Number.isFinite(value) && value >= MIN_CHARACTER_HEIGHT_M && value <= MAX_CHARACTER_HEIGHT_M
}
