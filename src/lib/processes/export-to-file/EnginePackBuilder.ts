import JSZip from 'jszip'
import { BinaryParser, type FBXNode } from '../../io/fbx/BinaryParser.ts'
import { FbxExportPreset } from './DownloadSettings.ts'
import { game_pack_looping_clip_names } from '../animations-listing/AnimationGamePack.ts'

export interface EnginePackAnimationFile {
  clip_name: string
  fbx_bytes: Uint8Array
}

export interface EnginePackTextureFile {
  file_name: string
  bytes: Uint8Array
}

export interface EnginePackContents {
  base_name: string
  fbx_export_preset: FbxExportPreset
  character_fbx_bytes: Uint8Array
  animation_files: EnginePackAnimationFile[]
}

/**
 * Builds the "Engine Pack" ZIP for Unreal / Unity (fork-only feature):
 *
 *   <base>_<preset>.zip
 *     README.txt                          import steps for the chosen engine
 *     <base>.fbx                          mesh + skeleton in bind pose, no animations
 *     Animations/<base>_<Clip>.fbx        skeleton + one clip each (same bone names)
 *     Textures/<file>.png                 textures embedded in <base>.fbx, as loose files
 */
export class EnginePackBuilder {
  public static readonly fallback_base_name = 'character'

  /**
   * Turns the uploaded model file name into a safe base name for every file in the pack.
   * e.g. "My Hunyuan model (2).glb" -> "My_Hunyuan_model_2"
   */
  public static base_name_from_source_file (source_file_name: string): string {
    const file_name = source_file_name.split(/[\\/]/).pop() ?? ''
    const without_extension = file_name.replace(/\.[^.]+$/, '')
    const base_name = EnginePackBuilder.sanitize_name(without_extension)
    return base_name === '' ? EnginePackBuilder.fallback_base_name : base_name
  }

  public static zip_file_name (base_name: string, fbx_export_preset: FbxExportPreset): string {
    return `${base_name}_${fbx_export_preset}.zip`
  }

  public static character_file_path (base_name: string): string {
    return `${base_name}.fbx`
  }

  /**
   * Animation file paths for the clips, in the same order.
   * Clip names that end up identical after sanitizing get a numeric suffix.
   */
  public static animation_file_paths (base_name: string, clip_names: string[]): string[] {
    const used_paths = new Set<string>()

    return clip_names.map((clip_name) => {
      const clip_part = EnginePackBuilder.sanitize_name(clip_name)
      const base_path = `Animations/${base_name}_${clip_part === '' ? 'Clip' : clip_part}`
      let path = `${base_path}.fbx`
      let suffix = 2
      while (used_paths.has(path)) {
        path = `${base_path}_${suffix}.fbx`
        suffix++
      }
      used_paths.add(path)
      return path
    })
  }

  /**
   * Reads the textures embedded in an FBX (Video nodes with Content), so they can be
   * shipped as loose files with the same names the FBX references.
   */
  public static extract_embedded_textures (fbx_bytes: Uint8Array): EnginePackTextureFile[] {
    const buffer = fbx_bytes.buffer.slice(fbx_bytes.byteOffset, fbx_bytes.byteOffset + fbx_bytes.byteLength) as ArrayBuffer
    const fbx_tree = new BinaryParser().parse(buffer)
    const video_nodes: Record<string, FBXNode> = fbx_tree.Objects?.Video ?? {}
    return EnginePackBuilder.textures_from_video_nodes(video_nodes)
  }

  public static textures_from_video_nodes (video_nodes: Record<string, FBXNode>): EnginePackTextureFile[] {
    const textures: EnginePackTextureFile[] = []
    const used_names = new Set<string>()

    Object.values(video_nodes).forEach((video_node) => {
      const content: unknown = video_node.Content
      if (!(content instanceof ArrayBuffer) || content.byteLength === 0) {
        return
      }

      const referenced_name: unknown = video_node.RelativeFilename ?? video_node.FileName
      const file_name = typeof referenced_name === 'string' ? referenced_name.split(/[\\/]/).pop() ?? '' : ''
      if (file_name === '' || used_names.has(file_name)) {
        return
      }

      used_names.add(file_name)
      textures.push({ file_name, bytes: new Uint8Array(content) })
    })

    return textures
  }

  public static async build_zip (contents: EnginePackContents): Promise<Uint8Array> {
    const zip = new JSZip()
    const { base_name, fbx_export_preset, character_fbx_bytes, animation_files } = contents

    const clip_names = animation_files.map(animation_file => animation_file.clip_name)
    const animation_paths = EnginePackBuilder.animation_file_paths(base_name, clip_names)
    const textures = EnginePackBuilder.extract_embedded_textures(character_fbx_bytes)

    zip.file('README.txt', EnginePackBuilder.readme_text(base_name, fbx_export_preset, clip_names, animation_paths, textures.length > 0))
    zip.file(EnginePackBuilder.character_file_path(base_name), character_fbx_bytes)
    animation_files.forEach((animation_file, index) => {
      zip.file(animation_paths[index], animation_file.fbx_bytes)
    })
    textures.forEach((texture) => {
      zip.file(`Textures/${texture.file_name}`, texture.bytes)
    })

    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  }

  public static readme_text (
    base_name: string,
    fbx_export_preset: FbxExportPreset,
    clip_names: string[],
    animation_paths: string[],
    has_textures: boolean
  ): string {
    const looping_clip_names = clip_names.filter(clip_name => game_pack_looping_clip_names.includes(clip_name))
    const looping_text = looping_clip_names.length > 0 ? looping_clip_names.join(', ') : 'idle, walk, run and in-air clips'
    const character_file = EnginePackBuilder.character_file_path(base_name)

    const lines: string[] = [
      `${base_name} - Mesh2Motion engine pack (${fbx_export_preset === FbxExportPreset.Unreal ? 'Unreal Engine' : 'Unity'})`,
      '',
      'Files',
      `  ${character_file}  character mesh + skeleton (bind pose), no animations`,
      ...animation_paths.map(path => `  ${path}  skeleton + one animation`),
      has_textures ? '  Textures/  copies of the textures embedded in the character FBX' : '',
      '',
      fbx_export_preset === FbxExportPreset.Unreal
        ? 'Units are centimeters, Y up: Unreal converts it with the default import settings, so the character imports at real size and standing. All clips are "in place" (no root motion).'
        : 'Units are meters (1.8 m character imports at real size). All clips are "in place" (no root motion).',
      `Looping clips: ${looping_text}.`,
      ''
    ]

    if (fbx_export_preset === FbxExportPreset.Unreal) {
      lines.push(
        'Unreal Engine 5.1',
        `1. Import ${character_file}:`,
        '   - Skeletal Mesh: on. Skeleton: leave empty (a new Skeleton is created).',
        '   - Import Animations: OFF. Import Uniform Scale: 1.0. Leave "Convert Scene" on (default).',
        has_textures ? '   - Materials: Import Textures on. If a texture is missing, import it from Textures/.' : '   - Materials: Import Textures on.',
        '2. Select every file in Animations/ and import them together:',
        `   - Skeleton: ${base_name}_Skeleton (created in step 1). Import Animations: on.`,
        '3. In the Animation Blueprint / Blend Space, set the looping clips to loop.',
        '   The jump is three clips: Start -> in-air loop -> Land.',
        'To add more animations later, export them again from Mesh2Motion with the same',
        'skeleton and import them choosing the same Skeleton asset.'
      )
    } else {
      lines.push(
        'Unity',
        '1. Copy this folder into Assets/.',
        `2. Select ${character_file}:`,
        '   - Model: Convert Units on, Scale Factor 1.',
        '   - Rig: Animation Type Humanoid, Avatar Definition "Create From This Model", Apply.',
        has_textures ? '   - Materials: Extract Textures (or use the files in Textures/).' : '   - Materials: Extract Textures if the model has textures.',
        '3. Select every file in Animations/:',
        `   - Rig: Animation Type Humanoid, Avatar Definition "Copy From Other Avatar" -> ${base_name}Avatar, Apply.`,
        '   - Animation: Loop Time on for the looping clips.',
        '     Root Transform Rotation / Position (Y) / Position (XZ): Bake Into Pose.',
        '4. Drag the clips into an Animator Controller.',
        '   The jump is three states: Start -> in-air loop -> Land.',
        'Humanoid clips can be shared between characters that use a Humanoid avatar.'
      )
    }

    return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n') + '\n'
  }

  private static sanitize_name (name: string): string {
    return name
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
  }
}
