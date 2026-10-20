import { describe, it, expect } from 'vitest'
import { Bone, BoxGeometry, Float32BufferAttribute, MeshBasicMaterial, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { BinaryParser, type FBXNode } from '../../io/fbx/BinaryParser'
import { type FBXTree } from '../../io/fbx/FBXTree'
import { FbxExportPreset } from './DownloadSettings'
import { fbx_unit_scale } from './FbxUnitScale'

/** A 1 m cube skinned to a single bone that sits 0.9 m above the origin. */
function make_skinned_scene (): Scene {
  const geometry = new BoxGeometry(1, 1, 1)
  const vertex_count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertex_count * 4), 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(
    Float32Array.from({ length: vertex_count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)), 4))

  const hips = new Bone()
  hips.name = 'pelvis'
  hips.position.set(0, 0.9, 0)

  const skinned_mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
  skinned_mesh.name = 'Body'
  skinned_mesh.add(hips)
  skinned_mesh.bind(new Skeleton([hips]))

  const scene = new Scene()
  scene.add(skinned_mesh)
  scene.updateMatrixWorld(true)
  return scene
}

async function export_and_parse (preset: FbxExportPreset): Promise<FBXTree> {
  const bytes = await new FBXExporter().parseAsync(make_skinned_scene(), {
    preset,
    unitScale: fbx_unit_scale(preset),
    includeAnimations: false,
    embedTextures: false
  })
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new BinaryParser().parse(buffer)
}

describe('FBX export unit scale', () => {
  it.each(Object.values(FbxExportPreset))('declares meters in GlobalSettings for the %s preset', async (preset) => {
    const fbx_tree = await export_and_parse(preset)

    expect(fbx_tree.GlobalSettings.UnitScaleFactor.value).toBe(100)
    expect(fbx_tree.GlobalSettings.OriginalUnitScaleFactor.value).toBe(100)
  })

  it.each(Object.values(FbxExportPreset))('keeps vertices and bones in meters for the %s preset', async (preset) => {
    const fbx_tree = await export_and_parse(preset)

    // the scale only lives in the header: nothing is baked into the data
    const geometry = Object.values<FBXNode>(fbx_tree.Objects.Geometry)[0]
    const max_coordinate = Math.max(...geometry.Vertices.a.map((value: number) => Math.abs(value)))
    expect(max_coordinate).toBeCloseTo(0.5)

    const pelvis = Object.values<FBXNode>(fbx_tree.Objects.Model).find((model) => model.attrName?.includes('pelvis') === true)
    expect(pelvis?.Lcl_Translation.value[1]).toBeCloseTo(0.9)
  })
})
