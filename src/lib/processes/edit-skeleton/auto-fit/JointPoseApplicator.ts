import { Quaternion, Vector3, type Bone, type Object3D, type Skeleton } from 'three'
import { type AutoFitResult, type HumanJointId } from './AutoFitTypes.ts'
import { Utility } from '../../../Utilities.ts'

/**
 * Semantic joints -> bone names of the Mesh2Motion human rig (static/rigs/rig-human.glb)
 */
export const MESH2MOTION_HUMAN_BONE_MAP: Readonly<Record<HumanJointId, string>> = {
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

// Hands are carried along: the finger bones are not estimated, so they are
// rotated and scaled around the wrist following the change of the forearm
const CARRIED_CHAINS: Array<{ wrist: HumanJointId, elbow: HumanJointId }> = [
  { wrist: 'wrist_l', elbow: 'elbow_l' },
  { wrist: 'wrist_r', elbow: 'elbow_r' }
]

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
  constructor (private readonly bone_map: Readonly<Record<HumanJointId, string>> = MESH2MOTION_HUMAN_BONE_MAP) {}

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
    const skipped_joint_ids: HumanJointId[] = []

    result.joints.forEach((joint) => {
      const bone = bones_by_name.get(this.bone_map[joint.id])
      if (bone === undefined) {
        skipped_joint_ids.push(joint.id)
        return
      }
      const target = new Vector3(...joint.world_position)
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
        throw new Error(`Auto Fit produced an invalid position for ${joint.id}.`)
      }
      targets.set(bone, target)
    })

    // most joints should exist, otherwise this is not the rig the map was made for
    if (targets.size < result.joints.length * 0.75) {
      throw new Error('The current skeleton does not match the human rig expected by Auto Fit.')
    }

    this.plan_carried_chains(bones_by_name, current_world, targets)

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
   * Bones under the wrist (fingers) keep their shape relative to the hand, but
   * are rotated with the forearm and scaled with its length, so an A-pose model
   * does not end up with fingers pointing out of the mesh.
   */
  private plan_carried_chains (bones_by_name: Map<string, Bone>, current_world: Map<Bone, Vector3>, targets: Map<Bone, Vector3>): void {
    CARRIED_CHAINS.forEach(({ wrist, elbow }) => {
      const wrist_bone = bones_by_name.get(this.bone_map[wrist])
      const elbow_bone = bones_by_name.get(this.bone_map[elbow])
      if (wrist_bone === undefined || elbow_bone === undefined) { return }

      const new_wrist = targets.get(wrist_bone)
      const new_elbow = targets.get(elbow_bone)
      const old_wrist = current_world.get(wrist_bone)
      const old_elbow = current_world.get(elbow_bone)
      if (new_wrist === undefined || new_elbow === undefined || old_wrist === undefined || old_elbow === undefined) { return }

      const old_forearm = old_wrist.clone().sub(old_elbow)
      const new_forearm = new_wrist.clone().sub(new_elbow)
      if (old_forearm.lengthSq() < 1e-12 || new_forearm.lengthSq() < 1e-12) { return }

      const scale = new_forearm.length() / old_forearm.length()
      const rotation = new Quaternion().setFromUnitVectors(old_forearm.clone().normalize(), new_forearm.clone().normalize())

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
