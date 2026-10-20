import { SkeletonType } from '../../enums/SkeletonType'

/**
 * "Game pack": predefined set of clips a typical game character needs
 * (idle, locomotion, jump cycle and death), selected with one click in the animation listing.
 *
 * Edit this list to change which clips the "Game Pack" button selects.
 * Names must match the clip names inside the animation GLB files exactly.
 * The listing shows underscores as spaces, so 'Jump_air' is shown as "Jump air".
 */
export const game_pack_clip_names_by_skeleton: Partial<Record<SkeletonType, readonly string[]>> = {
  [SkeletonType.Human]: [
    'Idle_A', // idle
    'Walk', // walk
    'Sprint', // run (there is no plain "Run" clip. "Jog" is slower, Run_Female / Run_Anime do not loop cleanly)
    // jump start -> jump air (loop) -> jump landing. The NinjaJump clips chain frame-to-frame.
    // The Jump_Start / Jump_air / Jump_Land set has a pose jump between Jump_air and Jump_Land
    'NinjaJump_Start', // jump start
    'NinjaJump_Idle', // jump air (in-air loop)
    'NinjaJump_Land', // jump landing (ends close to Idle_A)
    'Death_A' // death (Death_B, Death_C and Death_D also exist)
  ]
}

export interface GamePackSelection {
  selected_indices: number[]
  missing_clip_names: string[]
}

export class AnimationGamePack {
  public static get_clip_names (skeleton_type: SkeletonType): readonly string[] {
    return game_pack_clip_names_by_skeleton[skeleton_type] ?? []
  }

  public static is_available_for (skeleton_type: SkeletonType): boolean {
    return AnimationGamePack.get_clip_names(skeleton_type).length > 0
  }

  /**
   * Finds which animations in the listing belong to the pack, matching clip names exactly.
   * If a name appears more than once (e.g. a custom import with the same name as a library clip),
   * only the first match is used so the pack never selects duplicates.
   * @param animation_names Names of all animations in listing order
   * @param pack_clip_names Exact clip names in the pack
   * @returns Indices to select (in listing order) and pack clip names that were not found
   */
  public static resolve_selection (animation_names: readonly string[], pack_clip_names: readonly string[]): GamePackSelection {
    const selected_indices: number[] = []
    const missing_clip_names: string[] = []

    for (const clip_name of pack_clip_names) {
      const animation_index = animation_names.indexOf(clip_name)
      if (animation_index === -1) {
        missing_clip_names.push(clip_name)
      } else if (!selected_indices.includes(animation_index)) {
        selected_indices.push(animation_index)
      }
    }

    selected_indices.sort((a, b) => a - b)
    return { selected_indices, missing_clip_names }
  }
}
