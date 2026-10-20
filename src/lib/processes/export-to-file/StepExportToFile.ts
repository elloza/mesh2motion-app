import { UI } from '../../UI.ts'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { FBXExporter } from '@comfyorg/fbx-exporter-three'
import { type AnimationClip, Scene, type SkinnedMesh, type Object3D, type Bone, type Quaternion, type Vector3 } from 'three'
import { type BoneNamingStructure, type DownloadSettings, ExportContents, ExportFormat, type FbxExportPreset } from './DownloadSettings.ts'
import { EnginePackBuilder, type EnginePackAnimationFile } from './EnginePackBuilder.ts'
import { ExportBoneNamingService } from './ExportBoneNamingService.ts'
import { ExportHierarchyService } from './ExportHierarchyService.ts'
import { ExportAnimationCleanupService } from './ExportAnimationCleanupService.ts'
import { GlbSkinCleanupService } from './GlbSkinCleanupService.ts'
import { AnimationUtility } from '../animations-listing/AnimationUtility.ts'
import { type AnimationExportSelection } from '../animations-listing/interfaces/AnimationExportSelection.ts'
import { FbxTextureCompatibilityService } from './FbxTextureCompatibilityService.ts'
import { export_fbx_for_engine } from './FbxEngineExport.ts'
import { character_size_factor, measure_character_height } from './CharacterHeight.ts'
import { PropsExportFilter } from '../animations-listing/props/PropsExportFilter.ts'

// Note: EventTarget is a built-in interface and do not need to import it
export class StepExportToFile extends EventTarget {
  private readonly ui: UI = UI.getInstance()
  private animation_clips_to_export: AnimationClip[] = []
  private readonly fbx_exporter: FBXExporter = new FBXExporter()

  public set_animation_clips_to_export (all_animations_clips: AnimationClip[], export_selections: AnimationExportSelection[]): void {
    this.animation_clips_to_export = []
    export_selections.forEach((selection) => {
      const source_clip: AnimationClip | undefined = all_animations_clips[selection.animation_index]
      if (source_clip === undefined) {
        return
      }

      if (selection.mirror_export_mode === 'none') {
        this.animation_clips_to_export.push(source_clip.clone())
        return
      }

      if (selection.mirror_export_mode === 'mirrored') {
        this.animation_clips_to_export.push(AnimationUtility.create_mirrored_clip(source_clip))
        return
      }

      // Export both normal and mirrored variants.
      this.animation_clips_to_export.push(source_clip.clone())
      this.animation_clips_to_export.push(AnimationUtility.create_mirrored_clip(source_clip))
    })
  }

  public export (
    skinned_meshes: SkinnedMesh[],
    filename: string = 'exported_model',
    download_settings: DownloadSettings): Promise<void> {

    if (this.animation_clips_to_export.length === 0) {
      console.log('ERROR: No animation clips added to export')
      return Promise.reject(new Error('No animation clips added to export'))
    }

    // "Skeleton only" exports just the bone hierarchy (the root bone subtree that hangs off
    // each skinned mesh) instead of the full skinned mesh, which excludes the mesh geometry.
    // The animation clips still target the bone names, so the selected animations continue
    // to work against the exported skeleton.
    const skeleton_only = download_settings.export_contents() === ExportContents.Skeleton
    // FBX files get the character height chosen in the download settings
    const size_factor = character_size_factor(download_settings.character_height(), measure_character_height(skinned_meshes))

    return this.with_objects_in_export_scene(
      skinned_meshes,
      this.animation_clips_to_export,
      download_settings.bone_naming_structure(),
      skeleton_only,
      async (export_scene, export_clips) => {
        console.log('SKINNED MESH DATA TO EXPORT:', skinned_meshes)
        console.log('animations to export', export_clips)

        await this.export_scene(
          export_scene,
          export_clips,
          filename,
          download_settings.export_format(),
          download_settings.fbx_export_preset(),
          size_factor
        )
      }
    )
      .catch((error) => {
        console.log('Error exporting file:', error)
        throw error
      })
  }

  /**
   * Fork-only "Engine Pack": a ZIP for Unreal / Unity with the character FBX (no animations),
   * one skeleton-only FBX per selected clip, the textures as loose files and a README.
   * Always FBX, using the FBX preset and bone naming chosen in the download settings.
   */
  public async export_engine_pack (
    skinned_meshes: SkinnedMesh[],
    source_file_name: string,
    download_settings: DownloadSettings
  ): Promise<void> {
    const base_name = EnginePackBuilder.base_name_from_source_file(source_file_name)
    const zip_bytes = await this.build_engine_pack_zip(
      skinned_meshes,
      base_name,
      download_settings.bone_naming_structure(),
      download_settings.fbx_export_preset(),
      download_settings.character_height()
    )
    this.save_uint8_array(zip_bytes, EnginePackBuilder.zip_file_name(base_name, download_settings.fbx_export_preset()))
  }

  public async build_engine_pack_zip (
    skinned_meshes: SkinnedMesh[],
    base_name: string,
    bone_naming_structure: BoneNamingStructure,
    fbx_export_preset: FbxExportPreset,
    target_height_m: number | null = null
  ): Promise<Uint8Array> {
    if (this.animation_clips_to_export.length === 0) {
      throw new Error('No animation clips added to export')
    }

    // the geometry is the bind pose, so the measured height does not depend on the frame on screen
    const size_factor = character_size_factor(target_height_m, measure_character_height(skinned_meshes))

    // export everything from the bind pose, so the rest pose in every FBX is the
    // edited skeleton pose instead of whatever animation frame is on screen.
    // The pose is applied again right before each file, in case anything moved the bones in between.
    const restore_bone_transforms = this.save_bone_transforms(skinned_meshes)

    try {
      const character_fbx_bytes = await this.with_objects_in_export_scene(
        skinned_meshes, [], bone_naming_structure, false,
        async (export_scene, export_clips) => {
          this.apply_bind_pose(skinned_meshes)
          return await this.create_fbx_bytes(export_scene, export_clips, fbx_export_preset, size_factor)
        }
      )

      const animation_files: EnginePackAnimationFile[] = []
      for (const clip of this.animation_clips_to_export) {
        const animation_file = await this.with_objects_in_export_scene(
          skinned_meshes, [clip], bone_naming_structure, true,
          async (export_scene, export_clips) => {
            this.apply_bind_pose(skinned_meshes)
            return {
              clip_name: export_clips[0].name,
              fbx_bytes: await this.create_fbx_bytes(export_scene, export_clips, fbx_export_preset, size_factor)
            }
          }
        )
        animation_files.push(animation_file)
      }

      return await EnginePackBuilder.build_zip({ base_name, fbx_export_preset, character_fbx_bytes, animation_files })
    } finally {
      restore_bone_transforms()
    }
  }

  /**
   * Prepares the objects and clips for an export, runs it, and always puts everything back:
   * bone names, props and the original parents of the moved objects.
   */
  private async with_objects_in_export_scene<T> (
    skinned_meshes: SkinnedMesh[],
    clips: AnimationClip[],
    bone_naming_structure: BoneNamingStructure,
    skeleton_only: boolean,
    run_export: (export_scene: Scene, export_clips: AnimationClip[]) => Promise<T>
  ): Promise<T> {
    const export_scene = new Scene()

    const export_clips = clips.map((clip) => {
      const cloned_clip = clip.clone()
      // Make action names consistent by replacing any whitespace with underscores
      cloned_clip.name = cloned_clip.name.replace(/\s+/g, '_')
      return cloned_clip
    })

    // Apply bone naming before re-parenting: the service traverses each skinned mesh to
    // find its bones, which are still children of the mesh at this point.
    const restore_bone_names = ExportBoneNamingService.apply_download_settings(
      skinned_meshes,
      export_clips,
      bone_naming_structure
    )

    const objects_to_export: Object3D[] = ExportHierarchyService.collect_objects_to_export(skinned_meshes, skeleton_only)
    const restore_props = skeleton_only ? PropsExportFilter.detach_props(objects_to_export) : () => {}

    // The base animation data can contain tracks for joints the user removed (e.g. fingers),
    // and keyframe times can contain float32 duplicates that glTF validators reject.
    // This runs after bone renaming so the track names match the final bone names.
    ExportAnimationCleanupService.clean_clips_for_export(export_clips, objects_to_export)

    // When exporting to a file, we need to temporarily move the exported objects to a new
    // scene. An object can only be part of one scene at a time, so we must move it back to
    // its original parent after exporting. For a skeleton-only export, the root bone's
    // original parent is its skinned mesh.
    const original_parents = new Map<Object3D, Object3D | null>()

    objects_to_export.forEach((object_to_export) => {
      // Save the original parent
      original_parents.set(object_to_export, object_to_export.parent)
      export_scene.add(object_to_export)
    })

    try {
      return await run_export(export_scene, export_clips)
    } finally {
      // Move the exported objects back to their original parents
      objects_to_export.forEach((exported_object) => {
        const original_par = original_parents.get(exported_object)
        if (original_par != null) {
          original_par.add(exported_object)
        } else {
          // If there was no original parent, remove it from the scene
          export_scene.remove(exported_object)
          console.log('ERROR: No original parent found for exported object when exporting and re-parenting to original scene')
        }
      })

      restore_props()
      restore_bone_names()
    }
  }

  private apply_bind_pose (skinned_meshes: SkinnedMesh[]): void {
    skinned_meshes.forEach((skinned_mesh) => {
      skinned_mesh.skeleton.pose()
    })
  }

  /**
   * Saves the current local transform of every bone and returns a function that restores it.
   */
  private save_bone_transforms (skinned_meshes: SkinnedMesh[]): () => void {
    const saved_transforms = new Map<Bone, { position: Vector3, quaternion: Quaternion, scale: Vector3 }>()

    skinned_meshes.forEach((skinned_mesh) => {
      skinned_mesh.skeleton.bones.forEach((bone) => {
        if (bone !== undefined && bone !== null && !saved_transforms.has(bone)) {
          saved_transforms.set(bone, { position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() })
        }
      })
    })

    return () => {
      saved_transforms.forEach((transform, bone) => {
        bone.position.copy(transform.position)
        bone.quaternion.copy(transform.quaternion)
        bone.scale.copy(transform.scale)
      })
    }
  }

  public async export_scene (
    exported_scene: Scene,
    animations_to_export: AnimationClip[],
    file_name: string,
    export_format: ExportFormat,
    fbx_export_preset: FbxExportPreset,
    size_factor: number = 1
  ): Promise<void> {
    if (export_format === ExportFormat.FBX) {
      await this.export_fbx(exported_scene, animations_to_export, file_name, fbx_export_preset, size_factor)
      return
    }

    await this.export_glb(exported_scene, animations_to_export, file_name)
  }

  public async export_glb (exported_scene: Scene, animations_to_export: AnimationClip[], file_name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const gltf_exporter = new GLTFExporter()

      const export_options = {
        binary: true,
        onlyVisible: false,
        embedImages: true,
        animations: animations_to_export
      }

      gltf_exporter.parse(
        exported_scene,
        (result: ArrayBuffer) => {
          // Handle the result of the export
          if (result !== null) {
            const cleaned_result = GlbSkinCleanupService.remove_skin_skeleton_properties(result)
            this.save_array_buffer(cleaned_result, `${file_name}.glb`)
            resolve() // Resolve the promise when the export is complete
          } else {
            console.log('ERROR: result is not an instance of ArrayBuffer')
            reject(new Error('Export result is not an ArrayBuffer'))
          }
        },
        (error: any) => {
          console.log('An error happened during parsing', error)
          reject(error) // Reject the promise if an error occurs
        },
        export_options
      )
    })
  }

  public async export_fbx (
    exported_scene: Scene,
    animations_to_export: AnimationClip[],
    file_name: string,
    fbx_export_preset: FbxExportPreset,
    size_factor: number = 1
  ): Promise<void> {
    const result = await this.create_fbx_bytes(exported_scene, animations_to_export, fbx_export_preset, size_factor)
    this.save_uint8_array(result, `${file_name}.fbx`)
  }

  private async create_fbx_bytes (
    exported_scene: Scene,
    animations_to_export: AnimationClip[],
    fbx_export_preset: FbxExportPreset,
    size_factor: number = 1
  ): Promise<Uint8Array> {
    const texture_compatibility_session = new FbxTextureCompatibilityService(exported_scene)

    try {
      return await export_fbx_for_engine(this.fbx_exporter, exported_scene, animations_to_export, fbx_export_preset, {
        include_animations: animations_to_export.length > 0,
        embed_textures: true,
        size_factor
      })
    } finally {
      texture_compatibility_session.restore()
      exported_scene.animations = []
    }
  }

  private save_file (blob: Blob, filename: string): void {
    if (this.ui.dom_export_button_hidden_link != null) {
      this.ui.dom_export_button_hidden_link.href = URL.createObjectURL(blob)
      this.ui.dom_export_button_hidden_link.download = filename
      this.ui.dom_export_button_hidden_link.click()
    } else {
      console.log('ERROR: dom_export_button_hidden_link is null')
    }
  }

  // used for GLB to turn content into a byte array for saving
  private save_array_buffer (buffer: ArrayBuffer, filename: string): void {
    this.save_file(new Blob([buffer], { type: 'application/octet-stream' }), filename)
  }

  // used for FBX exporter to turn content into a byte array for saving
  private save_uint8_array (buffer: Uint8Array, filename: string): void {
    this.save_file(new Blob([buffer], { type: 'application/octet-stream' }), filename)
  }
}
