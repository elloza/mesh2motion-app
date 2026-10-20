import { describe, it, expect } from 'vitest'
import { Bone, BoxGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, Quaternion, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { BinaryParser, type FBXNode } from '../../io/fbx/BinaryParser'
import { character_size_factor, DEFAULT_CHARACTER_HEIGHT_M, is_valid_character_height, measure_character_height } from './CharacterHeight'
import { export_fbx_for_engine } from './FbxEngineExport'
import { FbxExportPreset } from './DownloadSettings'

/** A 1.15 m tall box skinned to one bone, like a normalized generated model */
function make_character (): SkinnedMesh {
  const geometry = new BoxGeometry(0.4, 1.15, 0.3)
  geometry.translate(0, 1.15 / 2, 0)
  const vertex_count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertex_count * 4), 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(Float32Array.from({ length: vertex_count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4))
  const pelvis = new Bone()
  pelvis.name = 'pelvis'
  pelvis.position.set(0, 0.55, 0)
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
  mesh.add(pelvis)
  mesh.bind(new Skeleton([pelvis]))
  return mesh
}

describe('character height', () => {
  it('defaults to the height of the Unreal mannequins', () => {
    expect(DEFAULT_CHARACTER_HEIGHT_M).toBe(1.8)
  })

  it('measures the bind pose of the skinned meshes, not the animated pose or held props', () => {
    const mesh = make_character()
    const prop = new Mesh(new BoxGeometry(0.1, 3, 0.1), new MeshBasicMaterial())
    mesh.skeleton.bones[0].add(prop) // a long prop held up high
    mesh.skeleton.bones[0].quaternion.copy(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1.2)) // animated frame

    expect(measure_character_height([mesh])).toBeCloseTo(1.15)
  })

  it('computes the scale factor and ignores invalid values', () => {
    expect(character_size_factor(1.8, 1.15)).toBeCloseTo(1.565, 3)
    expect(character_size_factor(null, 1.15)).toBe(1)
    expect(character_size_factor(1.8, 0)).toBe(1)
    expect(character_size_factor(-2, 1.15)).toBe(1)
    expect(is_valid_character_height(1.8)).toBe(true)
    expect(is_valid_character_height(0)).toBe(false)
    expect(is_valid_character_height(Number.NaN)).toBe(false)
  })

  it('exports an Unreal FBX of a 1.15 m model at 180 cm when asked for 1.80 m', async () => {
    const mesh = make_character()
    const scene = new Scene()
    scene.add(mesh)
    scene.updateMatrixWorld(true)
    const factor = character_size_factor(1.8, measure_character_height([mesh]))
    const bytes = await export_fbx_for_engine(new FBXExporter(), scene, [], FbxExportPreset.Unreal, {
      include_animations: false,
      embed_textures: false,
      size_factor: factor
    })
    const tree = new BinaryParser().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const vertices: number[] = Object.values<FBXNode>(tree.Objects.Geometry)[0].Vertices.a
    const ys = vertices.filter((_, index) => index % 3 === 1)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(180, 1)
  })
})
