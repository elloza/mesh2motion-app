import { type AnimationClip, type BufferGeometry, type Matrix4, type Mesh, type Object3D, type Scene, type Skeleton, type SkinnedMesh, type Vector3 } from 'three'
import { type FBXExporter } from '@comfyorg/fbx-exporter-three'
import { FbxExportPreset } from './DownloadSettings.ts'
import { AnimationUtility } from '../animations-listing/AnimationUtility.ts'

export interface FbxSpaceSettings {
  // axes written in GlobalSettings. They describe the data as it is: three.js is Y up, Z forward
  axis_up: 'Y'
  axis_forward: 'Z'
  // GlobalSettings.UnitScaleFactor (centimeters per file unit)
  unit_scale: number
  // factor applied to the exported data (vertices, bone translations, position keys)
  data_scale: number
}

/**
 * How each engine wants the file, checked by importing into Unreal Engine 5.1.1:
 *
 * Unreal: the importer converts axes by default ("Convert Scene"), but does NOT
 * convert units ("Convert Scene Unit" is off by default) and reads every value as
 * centimeters. So the data itself has to be in centimeters, and the header has to
 * say Y up so the character is rotated to stand up. The preset of
 * @comfyorg/fbx-exporter-three declares Z up without rotating the data, which
 * imported characters lying down; and meters in the header alone imported them
 * 100x too small.
 *
 * Unity: "Convert Units" is on by default, so meters in the header with data in
 * meters imports at real size.
 */
const FBX_SPACE_BY_PRESET: Record<FbxExportPreset, FbxSpaceSettings> = {
  [FbxExportPreset.Unreal]: { axis_up: 'Y', axis_forward: 'Z', unit_scale: 1, data_scale: 100 },
  [FbxExportPreset.Unity]: { axis_up: 'Y', axis_forward: 'Z', unit_scale: 100, data_scale: 1 }
}

export function fbx_space_settings (preset: FbxExportPreset): FbxSpaceSettings {
  return FBX_SPACE_BY_PRESET[preset]
}

export interface EngineFbxOptions {
  include_animations: boolean
  embed_textures: boolean
}

/**
 * Export a scene to FBX for an engine preset. The scene is scaled for the
 * export when the engine needs it and restored afterwards, even if exporting fails.
 */
export async function export_fbx_for_engine (
  exporter: FBXExporter,
  scene: Scene,
  animations: AnimationClip[],
  preset: FbxExportPreset,
  options: EngineFbxOptions
): Promise<Uint8Array> {
  const settings = fbx_space_settings(preset)
  const restore_scene = scale_scene_for_export(scene, settings.data_scale)
  const clips = scale_clips_for_export(animations, settings.data_scale)
  const previous_scene_animations = scene.animations
  scene.animations = clips

  try {
    return await exporter.parseAsync(scene, {
      preset,
      axisUp: settings.axis_up,
      axisForward: settings.axis_forward,
      unitScale: settings.unit_scale,
      includeAnimations: options.include_animations,
      animations: clips,
      onlyVisible: false,
      embedTextures: options.embed_textures
    })
  } finally {
    scene.animations = previous_scene_animations
    restore_scene()
  }
}

/**
 * Uniformly scale everything under the scene: local positions, mesh geometry
 * (on temporary copies) and the skin bind data. Bones are rigid, so the bind
 * matrices only need their translation scaled.
 * @returns a function that puts everything back exactly as it was
 */
export function scale_scene_for_export (scene: Scene, factor: number): () => void {
  if (factor === 1) { return () => {} }

  const positions: Array<[Object3D, Vector3]> = []
  const geometries: Array<[Mesh, BufferGeometry]> = []
  const skeletons = new Map<Skeleton, Matrix4[]>()
  const bind_matrices: Array<[SkinnedMesh, Matrix4, Matrix4]> = []

  scene.traverse((object: Object3D) => {
    if (object === scene) { return }
    positions.push([object, object.position.clone()])
    object.position.multiplyScalar(factor)

    const mesh = object as Mesh
    if (mesh.isMesh === true && mesh.geometry !== undefined) {
      geometries.push([mesh, mesh.geometry])
      const scaled = mesh.geometry.clone()
      scaled.scale(factor, factor, factor)
      mesh.geometry = scaled
    }

    const skinned_mesh = object as SkinnedMesh
    if (skinned_mesh.isSkinnedMesh === true) {
      bind_matrices.push([skinned_mesh, skinned_mesh.bindMatrix.clone(), skinned_mesh.bindMatrixInverse.clone()])
      scale_translation(skinned_mesh.bindMatrix, factor)
      scale_translation(skinned_mesh.bindMatrixInverse, factor)
      const skeleton = skinned_mesh.skeleton
      if (!skeletons.has(skeleton)) {
        skeletons.set(skeleton, skeleton.boneInverses.map(inverse => inverse.clone()))
        skeleton.boneInverses.forEach(inverse => { scale_translation(inverse, factor) })
      }
    }
  })
  scene.updateMatrixWorld(true)

  return () => {
    positions.forEach(([object, position]) => { object.position.copy(position) })
    geometries.forEach(([mesh, geometry]) => {
      mesh.geometry.dispose()
      mesh.geometry = geometry
    })
    bind_matrices.forEach(([mesh, bind, bind_inverse]) => {
      mesh.bindMatrix.copy(bind)
      mesh.bindMatrixInverse.copy(bind_inverse)
    })
    skeletons.forEach((inverses, skeleton) => {
      inverses.forEach((inverse, index) => { skeleton.boneInverses[index].copy(inverse) })
    })
    scene.updateMatrixWorld(true)
  }
}

function scale_clips_for_export (clips: AnimationClip[], factor: number): AnimationClip[] {
  if (factor === 1) { return clips }
  const scaled = AnimationUtility.deep_clone_animation_clips(clips)
  // KeyframeTrack.clone() can share its values array with the original, so copy
  // position values before scaling them to never touch the app's clips
  scaled.forEach((clip) => {
    clip.tracks.forEach((track) => {
      if (track.name.includes('.position')) {
        track.values = track.values.slice()
      }
    })
  })
  AnimationUtility.apply_skeleton_scale_to_position_keyframes(scaled, factor)
  return scaled
}

function scale_translation (matrix: Matrix4, factor: number): void {
  matrix.elements[12] *= factor
  matrix.elements[13] *= factor
  matrix.elements[14] *= factor
}
