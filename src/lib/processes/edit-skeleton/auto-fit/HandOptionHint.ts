import { type Bone } from 'three'

/*
 * Generated models (image to 3D) very often have the fingers joined into one
 * "mitten". With a bone chain per finger, the skinning splits that mitten
 * between fingers that the animations bend differently, and the hands tear.
 *
 * Measured on a 50k triangle generated model, animating 11 library clips
 * (share of hand mesh edges stretched more than 2x):
 *   All Fingers 5.5%, Thumb + Main Finger 5.4%, Single Hand Bone 2.6%
 * For reference, the clean sample mannequin with All Fingers gives 3.0%.
 *
 * An automatic per-model detection was tried and was not reliable enough
 * (low poly models with separated fingers scored like joined ones), so this
 * is a plain hint shown after applying Auto Fit to a rig with every finger.
 */
export const JOINED_FINGERS_HINT: string = 'Tip: models generated from an image usually have the fingers joined. If the hands tear when animating, go back and choose "Single Hand Bone" in the hand options, then run Auto Fit again.'

/**
 * Does the rig have a separate bone chain for every finger ("All Fingers" or
 * "All Fingers - Simplified")? Only then can joined fingers tear.
 */
export function rig_has_individual_fingers (bones: Bone[]): boolean {
  return bones.some(bone => /^(ring|pinky)_/.test(bone.name))
}
