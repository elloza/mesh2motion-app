import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  AnimationClip, Bone, BoxGeometry, Float32BufferAttribute, MeshBasicMaterial, QuaternionKeyframeTrack,
  Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute
} from 'three'
import { BinaryParser, type FBXNode } from '../../io/fbx/BinaryParser'
import { type FBXTree } from '../../io/fbx/FBXTree'
import { BoneNamingStructure, FbxExportPreset } from './DownloadSettings'
import { EnginePackBuilder } from './EnginePackBuilder'
import { StepExportToFile } from './StepExportToFile'
import { type AnimationExportSelection } from '../animations-listing/interfaces/AnimationExportSelection'

function parse_fbx (bytes: Uint8Array): FBXTree {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new BinaryParser().parse(buffer)
}

function animation_stack_names (fbx_tree: FBXTree): string[] {
  return Object.values<FBXNode>(fbx_tree.Objects.AnimationStack ?? {}).map(stack => String(stack.attrName))
}

/** A 1 m cube skinned to pelvis (0.9 m up) with a spine child bone. */
function make_skinned_mesh (): SkinnedMesh {
  const geometry = new BoxGeometry(1, 1, 1)
  const vertex_count = geometry.attributes.position.count
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(vertex_count * 4), 4))
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(
    Float32Array.from({ length: vertex_count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)), 4))

  const pelvis = new Bone()
  pelvis.name = 'pelvis'
  pelvis.position.set(0, 0.9, 0)
  const spine = new Bone()
  spine.name = 'spine_01'
  spine.position.set(0, 0.2, 0)
  pelvis.add(spine)

  const skinned_mesh = new SkinnedMesh(geometry, new MeshBasicMaterial())
  skinned_mesh.name = 'Body'
  skinned_mesh.add(pelvis)
  skinned_mesh.bind(new Skeleton([pelvis, spine]))

  const scene = new Scene()
  scene.add(skinned_mesh)
  scene.updateMatrixWorld(true)
  return skinned_mesh
}

function make_clip (name: string): AnimationClip {
  return new AnimationClip(name, 1, [
    new QuaternionKeyframeTrack('spine_01.quaternion', [0, 1], [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795])
  ])
}

describe('EnginePackBuilder names', () => {
  it('builds a safe base name from the uploaded file name', () => {
    expect(EnginePackBuilder.base_name_from_source_file('My Hunyuan model (2).glb')).toBe('My_Hunyuan_model_2')
    expect(EnginePackBuilder.base_name_from_source_file('models/knight.fbx')).toBe('knight')
    expect(EnginePackBuilder.base_name_from_source_file('C:\\fakepath\\robot.v2.glb')).toBe('robot_v2')
    expect(EnginePackBuilder.base_name_from_source_file('???.glb')).toBe('character')
    expect(EnginePackBuilder.base_name_from_source_file('')).toBe('character')
  })

  it('names the zip after the model and the engine preset', () => {
    expect(EnginePackBuilder.zip_file_name('knight', FbxExportPreset.Unreal)).toBe('knight_unreal.zip')
    expect(EnginePackBuilder.zip_file_name('knight', FbxExportPreset.Unity)).toBe('knight_unity.zip')
  })

  it('puts one animation file per clip in Animations/ and keeps names unique', () => {
    expect(EnginePackBuilder.animation_file_paths('knight', ['Idle_A', 'Sprint', 'Walk_mirror', 'Idle A', 'Idle_A'])).toEqual([
      'Animations/knight_Idle_A.fbx',
      'Animations/knight_Sprint.fbx',
      'Animations/knight_Walk_mirror.fbx',
      'Animations/knight_Idle_A_2.fbx',
      'Animations/knight_Idle_A_3.fbx'
    ])
  })
})

describe('EnginePackBuilder textures', () => {
  it('extracts embedded textures with the file name the FBX references', () => {
    const png_bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const textures = EnginePackBuilder.textures_from_video_nodes({
      1: { RelativeFilename: 'Skin_BaseColor.png', Content: png_bytes.buffer } as unknown as FBXNode,
      2: { RelativeFilename: 'Skin_BaseColor.png', Content: png_bytes.buffer } as unknown as FBXNode, // duplicate
      3: { RelativeFilename: 'textures\\eyes.png', Content: new Uint8Array([1, 2]).buffer } as unknown as FBXNode,
      4: { RelativeFilename: 'not_embedded.png' } as unknown as FBXNode
    })

    expect(textures.map(texture => texture.file_name)).toEqual(['Skin_BaseColor.png', 'eyes.png'])
    expect(Array.from(textures[0].bytes)).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})

describe('EnginePackBuilder README', () => {
  const paths = ['Animations/knight_Idle_A.fbx', 'Animations/knight_NinjaJump_Start.fbx']

  it('explains the Unreal 5.1 import against the character skeleton', () => {
    const readme = EnginePackBuilder.readme_text('knight', FbxExportPreset.Unreal, ['Idle_A', 'NinjaJump_Start'], paths, true)
    expect(readme).toContain('Unreal Engine 5.1')
    expect(readme).toContain('Import Animations: OFF')
    expect(readme).toContain('knight_Skeleton')
    expect(readme).toContain('Animations/knight_NinjaJump_Start.fbx')
    expect(readme).toContain('Looping clips: Idle_A.')
    expect(readme).toContain('Textures/')
    expect(readme).not.toContain('Unity')
  })

  it('explains the Unity Humanoid import with a shared avatar', () => {
    const readme = EnginePackBuilder.readme_text('knight', FbxExportPreset.Unity, ['Idle_A', 'NinjaJump_Start'], paths, false)
    expect(readme).toContain('Humanoid')
    expect(readme).toContain('"Copy From Other Avatar" -> knightAvatar')
    expect(readme).toContain('Loop Time')
    expect(readme).not.toContain('Textures/')
    expect(readme).not.toContain('Unreal')
  })
})

describe('StepExportToFile.build_engine_pack_zip', () => {
  async function build_pack (skinned_mesh: SkinnedMesh, preset: FbxExportPreset): Promise<JSZip> {
    const step = new StepExportToFile()
    const clips = [make_clip('Idle_A'), make_clip('Sprint'), make_clip('Death A')]
    const selections: AnimationExportSelection[] = clips.map((_, index) => ({ animation_index: index, mirror_export_mode: 'none' }))
    step.set_animation_clips_to_export(clips, selections)

    const zip_bytes = await step.build_engine_pack_zip([skinned_mesh], 'knight', BoneNamingStructure.Default, preset)
    return await JSZip.loadAsync(zip_bytes)
  }

  it.each(Object.values(FbxExportPreset))('writes the character, one FBX per clip and a README (%s)', async (preset) => {
    const zip = await build_pack(make_skinned_mesh(), preset)

    expect(Object.keys(zip.files).filter(path => !zip.files[path].dir).sort()).toEqual([
      'Animations/knight_Death_A.fbx',
      'Animations/knight_Idle_A.fbx',
      'Animations/knight_Sprint.fbx',
      'README.txt',
      'knight.fbx'
    ])

    // character: mesh + skeleton, no animation takes, meters declared
    const character = parse_fbx(await zip.file('knight.fbx')!.async('uint8array'))
    expect(Object.keys(character.Objects.Geometry ?? {}).length).toBe(1)
    expect(animation_stack_names(character)).toEqual([])
    expect(character.GlobalSettings.UnitScaleFactor.value).toBe(100)

    // each animation: skeleton only, exactly its own take
    for (const clip_name of ['Idle_A', 'Sprint', 'Death_A']) {
      const animation = parse_fbx(await zip.file(`Animations/knight_${clip_name}.fbx`)!.async('uint8array'))
      expect(Object.keys(animation.Objects.Geometry ?? {}).length).toBe(0)
      expect(animation_stack_names(animation)).toEqual([clip_name])
      const bone_names = Object.values<FBXNode>(animation.Objects.Model).map(model => String(model.attrName))
      expect(bone_names).toEqual(expect.arrayContaining(['pelvis', 'spine_01']))
    }
  })

  it('exports the character in bind pose and restores the current pose and hierarchy', async () => {
    const skinned_mesh = make_skinned_mesh()
    const [pelvis, spine] = skinned_mesh.skeleton.bones
    // simulate an animation frame on screen
    pelvis.position.set(0.3, 0.5, 0.1)
    spine.rotation.set(0.4, 0, 0)
    const animated_spine_quaternion = spine.quaternion.clone()

    const zip = await build_pack(skinned_mesh, FbxExportPreset.Unreal)

    const character = parse_fbx(await zip.file('knight.fbx')!.async('uint8array'))
    const exported_pelvis = Object.values<FBXNode>(character.Objects.Model).find(model => model.attrName === 'pelvis')
    expect(exported_pelvis?.Lcl_Translation.value[1]).toBeCloseTo(0.9)

    // the animation files use the same rest pose
    const animation = parse_fbx(await zip.file('Animations/knight_Sprint.fbx')!.async('uint8array'))
    const animation_pelvis = Object.values<FBXNode>(animation.Objects.Model).find(model => model.attrName === 'pelvis')
    expect(animation_pelvis?.Lcl_Translation.value.map((value: number) => Number(value.toFixed(3)))).toEqual([0, 0.9, 0])

    expect(pelvis.position.toArray()).toEqual([0.3, 0.5, 0.1])
    expect(spine.quaternion.equals(animated_spine_quaternion)).toBe(true)
    expect(pelvis.parent).toBe(skinned_mesh)
    expect(skinned_mesh.parent?.type).toBe('Scene')
  })

  it('refuses to build a pack without clips', async () => {
    const step = new StepExportToFile()
    await expect(step.build_engine_pack_zip([make_skinned_mesh()], 'knight', BoneNamingStructure.Default, FbxExportPreset.Unity))
      .rejects.toThrow('No animation clips')
  })
})
