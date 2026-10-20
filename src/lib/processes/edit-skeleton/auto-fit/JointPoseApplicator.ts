import { Quaternion, Vector3, type Bone, type Object3D, type Skeleton } from 'three'
import { type AutoFitResult, type HumanJointId } from './AutoFitTypes.ts'
import { Utility } from '../../../Utilities.ts'

/**
 * Semantic joints -> bone names of the Mesh2Motion human rig (static/rigs/rig-human.glb).
 * The finger tips have no bone of their own: they drive the whole finger chain (see HAND_CHAINS).
 */
export const MESH2MOTION_HUMAN_BONE_MAP: Readonly<Partial<Record<HumanJointId, string>>> = {
  pelvis: 'pelvis',
  spine_lower: 'spine_01',
  spine_middle: 'spine_02',
  spine_upper: 'spine_03',
  neck: 'neck_01',
  head: 'head',
  head_top: 'head_leaf',
  clavicle_l: 'clavicle_l',
  shoulder_l: 'upperarm_l',
  elbow_l: 'lowerarm_l',
  wrist_l: 'hand_l',
  clavicle_r: 'clavicle_r',
  shoulder_r: 'upperarm_r',
  elbow_r: 'lowerarm_r',
  wrist_r: 'hand_r',
  hip_l: 'thigh_l',
  knee_l: 'calf_l',
  ankle_l: 'foot_l',
  ball_l: 'ball_l',
  toe_l: 'ball_leaf_l',
  hip_r: 'thigh_r',
  knee_r: 'calf_r',
  ankle_r: 'foot_r',
  ball_r: 'ball_r',
  toe_r: 'ball_leaf_r'
}

// Fingers are not estimated one by one. The rig's hand (all bones under the
// wrist) keeps its shape, and is rotated and scaled around the wrist so its
// middle finger ends at the measured finger tip.
const HAND_CHAINS: Array<{ wrist: HumanJointId, elbow: HumanJointId, fingertip: HumanJointId }> = [
  { wrist: 'wrist_l', elbow: 'elbow_l', fingertip: 'fingertip_l' },
  { wrist: 'wrist_r', elbow: 'elbow_r', fingertip: 'fingertip_r' }
]

// Straight line distance from the wrist of each middle finger bone, as a
// fraction of the wrist -> finger tip distance, measured on the Mesh2Motion
// human rig. Some hand variations remove the last bones, so the deepest one
// left tells where the rig's finger tip would be (middle_01 is about 4 degrees
// off the wrist -> tip line, so the single bone hand is slightly less exact).
const MIDDLE_FINGER_FRACTIONS: Array<[RegExp, number]> = [
  [/^middle_04_leaf_/, 1.0],
  [/^middle_03_/, 0.8546],
  [/^middle_02_/, 0.7047],
  [/^middle_01_/, 0.5069]
]

/**
 * Where the rig's middle finger tip is (world space), for any hand variation
 * @param world_position_of current world position of a bone
 */
export function estimate_rig_fingertip (wrist_bone: Bone, world_position_of: (bone: Bone) => Vector3 | undefined): Vector3 | null {
  const wrist = world_position_of(wrist_bone)
  if (wrist === undefined) { return null }

  const references: Array<{ position: Vector3, fraction: number }> = []
  wrist_bone.traverse((descendant: Object3D) => {
    const match = MIDDLE_FINGER_FRACTIONS.find(([pattern]) => pattern.test(descendant.name))
    const position = match === undefined ? undefined : world_position_of(descendant as Bone)
    if (match !== undefined && position !== undefined) {
      references.push({ position, fraction: match[1] })
    }
  })
  if (references.length === 0) { return null }

  const deepest = references.reduce((best, candidate) => candidate.fraction > best.fraction ? candidate : best)
  return deepest.position.clone().sub(wrist).divideScalar(deepest.fraction).add(wrist)
}

export interface JointApplicationPlan {
  // world space target for every bone that will move, in parent -> child order
  targets: Array<{ bone: Bone, world_position: Vector3 }>
  skipped_joint_ids: HumanJointId[]
}

export interface JointApplicationReport {
  moved_bone_names: string[]
  skipped_joint_ids: HumanJointId[]
  max_position_error: number
}

/*
 * JointPoseApplicator
 * Moves the bones of the editable skeleton to the positions proposed by Auto Fit.
 *
 * - Only bone positions change. Rotations, scale, names, hierarchy and bone
 *   count stay exactly as they were, the same as dragging joints by hand with
 *   "Move Bone Children" enabled. Binding happens later in the normal skinning step.
 * - Every target is computed in world space BEFORE anything moves, then the
 *   bones are moved from the root down, converting world -> local with the
 *   parent's current matrix, so moving a parent never drags a child off target.
 * - If anything goes wrong while applying, the skeleton is restored.
 */
export class JointPoseApplicator {
  constructor (private readonly bone_map: Readonly<Partial<Record<HumanJointId, string>>> = MESH2MOTION_HUMAN_BONE_MAP) {}

  /**
   * Validate a result against a skeleton and work out the target of each bone.
   * Does not modify the skeleton. Throws if the result cannot be applied.
   */
  public plan (skeleton: Skeleton, result: AutoFitResult): JointApplicationPlan {
    if (result.status === 'unsupported' || result.joints.length === 0) {
      throw new Error('This Auto Fit result cannot be applied.')
    }

    skeleton.bones.forEach(bone => { bone.updateWorldMatrix(true, false) })
    const bones_by_name = new Map<string, Bone>()
    skeleton.bones.forEach(bone => bones_by_name.set(bone.name, bone))

    const current_world = new Map<Bone, Vector3>()
    skeleton.bones.forEach(bone => current_world.set(bone, Utility.world_position_from_object(bone)))

    const targets = new Map<Bone, Vector3>()
    const joint_targets = new Map<HumanJointId, Vector3>()
    const skipped_joint_ids: HumanJointId[] = []
    let mapped_joint_count = 0

    result.joints.forEach((joint) => {
      const target = new Vector3(...joint.world_position)
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
        throw new Error(`Auto Fit produced an invalid position for ${joint.id}.`)
      }
      joint_targets.set(joint.id, target)

      const bone_name = this.bone_map[joint.id]
      if (bone_name === undefined) { return } // used indirectly, like the finger tips
      mapped_joint_count++
      const bone = bones_by_name.get(bone_name)
      if (bone === undefined) {
        skipped_joint_ids.push(joint.id)
        return
      }
      targets.set(bone, target)
    })

    // most joints should exist, otherwise this is not the rig the map was made for
    if (targets.size < mapped_joint_count * 0.75) {
      throw new Error('The current skeleton does not match the human rig expected by Auto Fit.')
    }

    this.plan_hands(bones_by_name, current_world, targets, joint_targets)

    const ordered = [...targets.keys()].sort((a, b) => JointPoseApplicator.depth(a) - JointPoseApplicator.depth(b))
    return {
      targets: ordered.map(bone => ({ bone, world_position: targets.get(bone) as Vector3 })),
      skipped_joint_ids
    }
  }

  /**
   * Move the bones. Assumes the skeleton has not changed since plan() was made.
   */
  public apply (skeleton: Skeleton, plan: JointApplicationPlan): JointApplicationReport {
    const backup = Utility.store_bone_transforms(skeleton)

    try {
      plan.targets.forEach(({ bone, world_position }) => {
        const parent = bone.parent
        if (parent === null) {
          bone.position.copy(world_position)
        } else {
          parent.updateWorldMatrix(true, false)
          bone.position.copy(parent.worldToLocal(world_position.clone()))
        }
        bone.updateMatrixWorld(true)
      })

      let max_position_error = 0
      plan.targets.forEach(({ bone, world_position }) => {
        const error = Utility.world_position_from_object(bone).distanceTo(world_position)
        if (!Number.isFinite(error)) {
          throw new Error(`Bone ${bone.name} ended up at an invalid position.`)
        }
        max_position_error = Math.max(max_position_error, error)
      })

      return {
        moved_bone_names: plan.targets.map(({ bone }) => bone.name),
        skipped_joint_ids: plan.skipped_joint_ids,
        max_position_error
      }
    } catch (error) {
      Utility.restore_bone_transforms(skeleton, backup)
      skeleton.bones.forEach(bone => { bone.updateWorldMatrix(true, true) })
      throw error
    }
  }

  /**
   * Bones under the wrist (fingers) keep their shape relative to the hand. The
   * whole hand is rotated and scaled around the wrist so the rig's middle finger
   * ends at the measured finger tip. Sizing the hand from the forearm instead
   * squeezes the fingers into the palm when proportions differ from the rig,
   * which makes the fingers bend in the wrong places (claw hands).
   * If there is no finger tip or middle finger, falls back to following the forearm.
   */
  private plan_hands (bones_by_name: Map<string, Bone>, current_world: Map<Bone, Vector3>, targets: Map<Bone, Vector3>, joint_targets: Map<HumanJointId, Vector3>): void {
    const bone_for = (id: HumanJointId): Bone | undefined => {
      const name = this.bone_map[id]
      return name === undefined ? undefined : bones_by_name.get(name)
    }

    HAND_CHAINS.forEach(({ wrist, elbow, fingertip }) => {
      const wrist_bone = bone_for(wrist)
      const elbow_bone = bone_for(elbow)
      if (wrist_bone === undefined || elbow_bone === undefined) { return }

      const new_wrist = targets.get(wrist_bone)
      const new_elbow = targets.get(elbow_bone)
      const old_wrist = current_world.get(wrist_bone)
      const old_elbow = current_world.get(elbow_bone)
      if (new_wrist === undefined || new_elbow === undefined || old_wrist === undefined || old_elbow === undefined) { return }

      const transform = JointPoseApplicator.hand_transform_from_fingertip(wrist_bone, old_wrist, new_wrist, current_world, joint_targets.get(fingertip)) ??
        JointPoseApplicator.hand_transform_from_forearm(old_elbow, old_wrist, new_elbow, new_wrist)
      if (transform === null) { return }
      const [rotation, scale] = transform

      wrist_bone.traverse((descendant: Object3D) => {
        const bone = descendant as Bone
        if (bone === wrist_bone || bone.isBone !== true || targets.has(bone)) { return }
        const old_position = current_world.get(bone)
        if (old_position === undefined) { return }
        const offset = old_position.clone().sub(old_wrist).applyQuaternion(rotation).multiplyScalar(scale)
        targets.set(bone, new_wrist.clone().add(offset))
      })
    })
  }

  private static hand_transform_from_fingertip (wrist_bone: Bone, old_wrist: Vector3, new_wrist: Vector3, current_world: Map<Bone, Vector3>, new_fingertip: Vector3 | undefined): [Quaternion, number] | null {
    if (new_fingertip === undefined) { return null }

    const old_fingertip = estimate_rig_fingertip(wrist_bone, bone => current_world.get(bone))
    if (old_fingertip === null) { return null }

    const old_hand = old_fingertip.sub(old_wrist)
    const new_hand = new_fingertip.clone().sub(new_wrist)
    if (old_hand.lengthSq() < 1e-12 || new_hand.lengthSq() < 1e-12) { return null }

    const scale = Math.min(Math.max(new_hand.length() / old_hand.length(), 0.25), 4)
    const rotation = new Quaternion().setFromUnitVectors(old_hand.normalize(), new_hand.normalize())
    return [rotation, scale]
  }

  private static hand_transform_from_forearm (old_elbow: Vector3, old_wrist: Vector3, new_elbow: Vector3, new_wrist: Vector3): [Quaternion, number] | null {
    const old_forearm = old_wrist.clone().sub(old_elbow)
    const new_forearm = new_wrist.clone().sub(new_elbow)
    if (old_forearm.lengthSq() < 1e-12 || new_forearm.lengthSq() < 1e-12) { return null }

    const scale = new_forearm.length() / old_forearm.length()
    const rotation = new Quaternion().setFromUnitVectors(old_forearm.normalize(), new_forearm.normalize())
    return [rotation, scale]
  }

  private static depth (object: Object3D): number {
    let depth = 0
    let current = object.parent
    while (current !== null) {
      depth++
      current = current.parent
    }
    return depth
  }
}
