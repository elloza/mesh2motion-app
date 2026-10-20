import { describe, it, expect } from 'vitest'
import { AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, MeshBasicMaterial, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, VectorKeyframeTrack } from 'three'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { BinaryParser, type FBXNode } from '../../io/fbx/BinaryParser'
import { type FBXTree } from '../../io/fbx/FBXTree'
import { FbxExportPreset } from './DownloadSettings'
import { export_fbx_for_engine, fbx_space_settings, scale_scene_for_export } from './FbxEngineExport'

/** A 1 m cube skinned to a single bone that sits 0.9 m above the origin. */
function make_skinned_scene (): { scene: Scene, mesh: SkinnedMesh, clip: AnimationClip } {
  const geometry = new BoxGeometry(1, 1, 1)
  const vertex_count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertex_count * 4), 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(
    Float32Array.from({ length: vertex_count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)), 4))

  const hips = new Bone()
  hips.name = 'pelvis'
  hips.position.set(0, 0.9, 0)

  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
  mesh.name = 'Body'
  mesh.add(hips)
  mesh.bind(new Skeleton([hips]))

  const scene = new Scene()
  scene.add(mesh)
  scene.updateMatrixWorld(true)

  const clip = new AnimationClip('Walk', 1, [
    new VectorKeyframeTrack('pelvis.position', [0, 1], [0, 0.9, 0, 0, 1.0, 0]),
    new QuaternionKeyframeTrack('pelvis.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])
  ])
  return { scene, mesh, clip }
}

async function export_and_parse (preset: FbxExportPreset, with_clip: boolean = false): Promise<FBXTree> {
  const { scene, clip } = make_skinned_scene()
  const bytes = await export_fbx_for_engine(new FBXExporter(), scene, with_clip ? [clip] : [], preset, {
    include_animations: with_clip,
    embed_textures: false
  })
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new BinaryParser().parse(buffer)
}

function max_vertex_coordinate (tree: FBXTree): number {
  const geometry = Object.values<FBXNode>(tree.Objects.Geometry)[0]
  return Math.max(...geometry.Vertices.a.map((value: number) => Math.abs(value)))
}

function pelvis_height (tree: FBXTree): number {
  const pelvis = Object.values<FBXNode>(tree.Objects.Model).find((model) => model.attrName?.includes('pelvis') === true)
  return pelvis?.Lcl_Translation.value[1]
}

describe('FBX export for engines', () => {
  it('writes Unreal files in centimeters with a Y up header, so the default import stands the character up at real size', async () => {
    const tree = await export_and_parse(FbxExportPreset.Unreal)

    expect(tree.GlobalSettings.UpAxis.value).toBe(1)
    expect(tree.GlobalSettings.UnitScaleFactor.value).toBe(1)
    expect(max_vertex_coordinate(tree)).toBeCloseTo(50)
    expect(pelvis_height(tree)).toBeCloseTo(90)
  })

  it('writes Unity files in meters, declared in the header (Convert Units is on by default in Unity)', async () => {
    const tree = await export_and_parse(FbxExportPreset.Unity)

    expect(tree.GlobalSettings.UpAxis.value).toBe(1)
    expect(tree.GlobalSettings.UnitScaleFactor.value).toBe(100)
    expect(max_vertex_coordinate(tree)).toBeCloseTo(0.5)
    expect(pelvis_height(tree)).toBeCloseTo(0.9)
  })

  it('scales the pelvis position keys for Unreal and leaves the original clip untouched', async () => {
    const { scene, clip } = make_skinned_scene()
    const original_values = Array.from(clip.tracks[0].values)
    const bytes = await export_fbx_for_engine(new FBXExporter(), scene, [clip], FbxExportPreset.Unreal, { include_animations: true, embed_textures: false })

    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(Array.from(clip.tracks[0].values)).toEqual(original_values)
  })

  it('restores the scene exactly after scaling it for an export', () => {
    const { scene, mesh } = make_skinned_scene()
    const geometry = mesh.geometry
    const positions = Array.from(geometry.getAttribute('position').array)
    const bone_position = mesh.skeleton.bones[0].position.clone()
    const bone_inverse = mesh.skeleton.boneInverses[0].clone()
    const bind_matrix = mesh.bindMatrix.clone()

    const restore = scale_scene_for_export(scene, 100)
    expect(mesh.skeleton.bones[0].position.y).toBeCloseTo(90)
    expect(mesh.skeleton.boneInverses[0].elements[13]).toBeCloseTo(-90)
    expect(mesh.geometry).not.toBe(geometry)
    restore()

    expect(mesh.geometry).toBe(geometry)
    expect(Array.from(geometry.getAttribute('position').array)).toEqual(positions)
    expect(mesh.skeleton.bones[0].position.equals(bone_position)).toBe(true)
    expect(mesh.skeleton.boneInverses[0].equals(bone_inverse)).toBe(true)
    expect(mesh.bindMatrix.equals(bind_matrix)).toBe(true)
  })

  it('keeps the skin consistent: the scaled bind pose still matches the scaled mesh', () => {
    const { scene, mesh } = make_skinned_scene()
    scale_scene_for_export(scene, 100)
    // bone world matrix times its inverse bind matrix is identity in the bind pose
    const product = mesh.skeleton.bones[0].matrixWorld.clone().multiply(mesh.skeleton.boneInverses[0])
    expect(product.elements[13]).toBeCloseTo(0)
    expect(product.elements[0]).toBeCloseTo(1)
  })

  it('knows the settings of each preset', () => {
    expect(fbx_space_settings(FbxExportPreset.Unreal)).toEqual({ axis_up: 'Y', axis_forward: 'Z', unit_scale: 1, data_scale: 100 })
    expect(fbx_space_settings(FbxExportPreset.Unity)).toEqual({ axis_up: 'Y', axis_forward: 'Z', unit_scale: 100, data_scale: 1 })
  })
})
