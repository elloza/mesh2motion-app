import { type Bone } from 'three'

/*
 * Generated models (image to 3D) very often have the fingers joined into one
 * "mitten". With a bone chain per finger, the skinning splits that mitten
 * between fingers that the animations bend differently, and the hands tear.
 * The "Thumb + Main Finger" hand option avoids that: on a generated model it
 * cut the mesh edges shared between differently moving fingers about 5 times.
 *
 * An automatic per-model detection was tried and was not reliable enough
 * (low poly models with separated fingers scored like joined ones), so this
 * is a plain hint shown after applying Auto Fit to a rig with every finger.
 */
export const JOINED_FINGERS_HINT: string = 'Tip: models generated from an image usually have the fingers joined. If the hands tear when animating, go back and choose "Thumb + Main Finger" in the hand options, then run Auto Fit again.'

/**
 * Does the rig have a separate bone chain for every finger ("All Fingers" or
 * "All Fingers - Simplified")? Only then can joined fingers tear.
 */
export function rig_has_individual_fingers (bones: Bone[]): boolean {
  return bones.some(bone => /^(ring|pinky)_/.test(bone.name))
}
