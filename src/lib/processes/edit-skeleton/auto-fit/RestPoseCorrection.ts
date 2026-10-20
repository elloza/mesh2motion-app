import { Quaternion, Vector3, type AnimationClip, type Bone, type Skeleton } from 'three'

export interface RestPoseCorrections {
  // rotation, in the bone's own frame, from the fitted to the template direction
  by_bone: Map<string, Quaternion>
  // parent bone name of every bone, to undo what a corrected parent passes down
  parent_of: Map<string, string>
}

// spine and pelvis keep their animation as authored, so the posture of the
// character is not changed
const EXCLUDED_BONES = /^(root|pelvis|spine_\d+)$/

/*
 * RestPoseCorrection
 * Auto Fit only moves joints, so a bone can end up pointing somewhere else than
 * in the rig template (e.g. forearms bent forward, arms in an A-pose). The
 * library animations are authored for the template directions, so that
 * difference would stay on top of every animation (arms look bent or squeezed,
 * hands twist).
 *
 * For each bone with a single bone child, the correction C is the rotation (in
 * the bone's own frame) that takes the fitted direction back to the template
 * one. A corrected parent also turns the frame its children inherit, so each
 * animated rotation becomes: inverse(C_parent) * q_animated * C_bone.
 * Then every bone points where the template animation intends.
 */
export class RestPoseCorrection {
  /**
   * Local direction to the child for every bone that has a single bone child
   * (and for hands, towards the middle finger)
   */
  public static child_directions (skeleton: Skeleton): Map<string, Vector3> {
    const directions = new Map<string, Vector3>()
    skeleton.bones.forEach((bone: Bone) => {
      if (EXCLUDED_BONES.test(bone.name)) { return }
      const bone_children = bone.children.filter(child => (child as Bone).isBone === true)
      // the hand points along its middle finger
      const reference_child = bone_children.length === 1
        ? bone_children[0]
        : bone_children.find(child => /^middle_01_/.test(child.name))
      if (reference_child === undefined) { return }
      const offset = reference_child.position.clone()
      if (offset.lengthSq() < 1e-12) { return }
      directions.set(bone.name, offset.normalize())
    })
    return directions
  }

  /**
   * @param template_directions child_directions() of the skeleton before fitting
   * @param fitted_skeleton the skeleton after fitting (same bones and rest rotations)
   * @param min_angle ignore differences smaller than this (radians)
   */
  public static compute (template_directions: Map<string, Vector3>, fitted_skeleton: Skeleton, min_angle: number = 0.01): RestPoseCorrections {
    const by_bone = new Map<string, Quaternion>()
    RestPoseCorrection.child_directions(fitted_skeleton).forEach((fitted_direction, bone_name) => {
      const template_direction = template_directions.get(bone_name)
      if (template_direction === undefined) { return }
      if (fitted_direction.angleTo(template_direction) < min_angle) { return }
      by_bone.set(bone_name, new Quaternion().setFromUnitVectors(fitted_direction, template_direction))
    })

    const parent_of = new Map<string, string>()
    fitted_skeleton.bones.forEach((bone) => {
      if (bone.parent !== null && (bone.parent as Bone).isBone === true) {
        parent_of.set(bone.name, bone.parent.name)
      }
    })
    return { by_bone, parent_of }
  }

  /**
   * Rewrite the rotation keyframes: inverse(C_parent) * q * C_bone.
   * Modifies the clips in place.
   */
  public static apply_to_clips (clips: AnimationClip[], corrections: RestPoseCorrections): void {
    if (corrections.by_bone.size === 0) { return }
    const keyframe = new Quaternion()
    clips.forEach((clip) => {
      clip.tracks.forEach((track) => {
        const match = /^(.*)\.quaternion$/.exec(track.name)
        if (match === null) { return }
        const own = corrections.by_bone.get(match[1])
        const parent_name = corrections.parent_of.get(match[1])
        const parent = parent_name === undefined ? undefined : corrections.by_bone.get(parent_name)
        if (own === undefined && parent === undefined) { return }
        const parent_inverse = parent?.clone().invert()

        const values = track.values.slice()
        for (let i = 0; i + 3 < values.length; i += 4) {
          keyframe.set(values[i], values[i + 1], values[i + 2], values[i + 3])
          if (parent_inverse !== undefined) { keyframe.premultiply(parent_inverse) }
          if (own !== undefined) { keyframe.multiply(own) }
          values[i] = keyframe.x
          values[i + 1] = keyframe.y
          values[i + 2] = keyframe.z
          values[i + 3] = keyframe.w
        }
        track.values = values
      })
    })
  }
}
