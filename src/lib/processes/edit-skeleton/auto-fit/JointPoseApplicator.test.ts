import { describe, it, expect } from 'vitest'
import { Group, Quaternion, Vector3, type Bone, type Skeleton } from 'three'
import { JointPoseApplicator, MESH2MOTION_HUMAN_BONE_MAP, estimate_rig_fingertip } from './JointPoseApplicator'
import { HUMAN_JOINT_IDS, type AutoFitResult, type HumanJointId, type Vec3Tuple } from './AutoFitTypes'
import { UndoRedoSystem } from '../UndoRedoSystem'
import { HandSkeletonType } from '../../../enums/SkeletonType'
import { load_human_rig_skeleton } from './test-fixtures/HumanRigLoader'

function world (bone: Bone): Vector3 {
  bone.updateWorldMatrix(true, false)
  return bone.getWorldPosition(new Vector3())
}

function bone_named (skeleton: Skeleton, name: string): Bone {
  const bone = skeleton.bones.find(candidate => candidate.name === name)
  if (bone === undefined) { throw new Error(`no bone ${name}`) }
  return bone
}

function snapshot_world (skeleton: Skeleton): Map<string, Vector3> {
  return new Map(skeleton.bones.map(bone => [bone.name, world(bone)]))
}

function make_result (positions: Partial<Record<HumanJointId, Vec3Tuple>>): AutoFitResult {
  return {
    status: 'success',
    pose: 'a-pose',
    joints: HUMAN_JOINT_IDS.map(id => ({ id, world_position: positions[id] as Vec3Tuple, confidence: 0.8, method: 'measured' as const, warnings: [] })),
    warnings: [],
    diagnostics: {}
  }
}

/**
 * Where a semantic joint is on the current rig. Finger tips have no bone of
 * their own: with all fingers it is the middle finger's leaf bone, otherwise
 * it is estimated from the middle finger bones that are left.
 */
function rig_position (skeleton: Skeleton, id: HumanJointId): Vector3 {
  const side = id.endsWith('_l') ? 'l' : 'r'
  if (id.startsWith('fingertip')) {
    return estimate_rig_fingertip(bone_named(skeleton, `hand_${side}`), world) as Vector3
  }
  return world(bone_named(skeleton, MESH2MOTION_HUMAN_BONE_MAP[id] as string))
}

/**
 * A plausible fit for a different character: the current rig joints are
 * scaled up, moved, and the arms are lowered 40 degrees into an A-pose.
 */
function a_pose_targets (skeleton: Skeleton): Partial<Record<HumanJointId, Vec3Tuple>> {
  const offset = new Vector3(0.3, 0.05, -0.2)
  const targets: Partial<Record<HumanJointId, Vec3Tuple>> = {}
  HUMAN_JOINT_IDS.forEach((id) => {
    const position = rig_position(skeleton, id).multiplyScalar(1.1).add(offset)
    targets[id] = position.toArray() as Vec3Tuple
  })
  ;(['l', 'r'] as const).forEach((side) => {
    const sign = side === 'l' ? 1 : -1
    const shoulder = new Vector3(...(targets[`shoulder_${side}`] as Vec3Tuple))
    const lower = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -sign * 40 * Math.PI / 180)
    ;([`elbow_${side}`, `wrist_${side}`, `fingertip_${side}`] as HumanJointId[]).forEach((id) => {
      const position = new Vector3(...(targets[id] as Vec3Tuple)).sub(shoulder).applyQuaternion(lower).add(shoulder)
      targets[id] = position.toArray() as Vec3Tuple
    })
  })
  return targets
}

describe('JointPoseApplicator', () => {
  it('moves every mapped bone of the real human rig to its target', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const targets = a_pose_targets(skeleton)
    const applicator = new JointPoseApplicator()

    const report = applicator.apply(skeleton, applicator.plan(skeleton, make_result(targets)))

    expect(report.skipped_joint_ids).toEqual([])
    expect(report.max_position_error).toBeLessThan(1e-5)
    HUMAN_JOINT_IDS.forEach((id) => {
      expect(rig_position(skeleton, id).distanceTo(new Vector3(...(targets[id] as Vec3Tuple))), id).toBeLessThan(1e-5)
    })
  })

  it('only changes bone positions: names, hierarchy, count, rotations and scale stay the same', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const before = skeleton.bones.map(bone => ({
      name: bone.name,
      parent: bone.parent?.name,
      quaternion: bone.quaternion.toArray(),
      scale: bone.scale.toArray()
    }))

    const applicator = new JointPoseApplicator()
    applicator.apply(skeleton, applicator.plan(skeleton, make_result(a_pose_targets(skeleton))))

    const after = skeleton.bones.map(bone => ({
      name: bone.name,
      parent: bone.parent?.name,
      quaternion: bone.quaternion.toArray(),
      scale: bone.scale.toArray()
    }))
    expect(after).toEqual(before)
  })

  it('sizes and turns the whole hand so the middle finger ends at the measured finger tip', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const old_thumb_offset = world(bone_named(skeleton, 'thumb_01_l')).sub(world(bone_named(skeleton, 'hand_l')))
    const old_hand_length = rig_position(skeleton, 'fingertip_l').distanceTo(world(bone_named(skeleton, 'hand_l')))

    // a hand with longer fingers than the forearm would suggest, pointing down
    const targets = a_pose_targets(skeleton)
    const wrist = new Vector3(...(targets.wrist_l as Vec3Tuple))
    const tip = wrist.clone().add(new Vector3(0.12, -0.2, 0.03))
    targets.fingertip_l = tip.toArray() as Vec3Tuple

    const applicator = new JointPoseApplicator()
    applicator.apply(skeleton, applicator.plan(skeleton, make_result(targets)))

    expect(world(bone_named(skeleton, 'middle_04_leaf_l')).distanceTo(tip)).toBeLessThan(1e-5)
    // the rest of the hand keeps its shape, scaled the same way
    const scale = tip.distanceTo(wrist) / old_hand_length
    const new_thumb_offset = world(bone_named(skeleton, 'thumb_01_l')).sub(world(bone_named(skeleton, 'hand_l')))
    expect(new_thumb_offset.length() / old_thumb_offset.length()).toBeCloseTo(scale, 4)
  })

  it('falls back to following the forearm when there is no finger tip', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const old_hand = world(bone_named(skeleton, 'hand_l'))
    const old_finger_offset = world(bone_named(skeleton, 'middle_01_l')).sub(old_hand)
    const old_forearm = old_hand.clone().sub(world(bone_named(skeleton, 'lowerarm_l')))

    const result = make_result(a_pose_targets(skeleton))
    result.joints = result.joints.filter(joint => !joint.id.startsWith('fingertip'))
    const applicator = new JointPoseApplicator()
    applicator.apply(skeleton, applicator.plan(skeleton, result))

    const new_hand = world(bone_named(skeleton, 'hand_l'))
    const new_forearm = new_hand.clone().sub(world(bone_named(skeleton, 'lowerarm_l')))
    const new_finger_offset = world(bone_named(skeleton, 'middle_01_l')).sub(new_hand)
    expect(new_finger_offset.angleTo(new_forearm)).toBeCloseTo(old_finger_offset.angleTo(old_forearm), 4)
    expect(new_finger_offset.y).toBeLessThan(-0.01)
  })

  it.each([HandSkeletonType.SimplifiedHand, HandSkeletonType.ThumbAndIndex, HandSkeletonType.SingleBone])('works with the %s hand variation and still reaches the finger tip', async (hand_type) => {
    const { skeleton } = await load_human_rig_skeleton(hand_type)
    const targets = a_pose_targets(skeleton)
    const applicator = new JointPoseApplicator()
    const report = applicator.apply(skeleton, applicator.plan(skeleton, make_result(targets)))

    expect(report.skipped_joint_ids).toEqual([])
    expect(report.max_position_error).toBeLessThan(1e-5)
    expect(rig_position(skeleton, 'fingertip_l').distanceTo(new Vector3(...(targets.fingertip_l as Vec3Tuple)))).toBeLessThan(1e-4)
  })

  it('places bones correctly when the armature itself is transformed', async () => {
    const { armature, skeleton } = await load_human_rig_skeleton()
    const holder = new Group()
    holder.position.set(2, -1, 3)
    holder.scale.setScalar(0.5)
    holder.add(armature)
    holder.updateMatrixWorld(true)

    const targets = a_pose_targets(skeleton)
    const applicator = new JointPoseApplicator()
    const report = applicator.apply(skeleton, applicator.plan(skeleton, make_result(targets)))

    expect(report.max_position_error).toBeLessThan(1e-5)
  })

  it('skips joints whose bone does not exist and reports them', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const applicator = new JointPoseApplicator({ ...MESH2MOTION_HUMAN_BONE_MAP, head_top: 'not_a_bone' })
    const plan = applicator.plan(skeleton, make_result(a_pose_targets(skeleton)))

    expect(plan.skipped_joint_ids).toEqual(['head_top'])
  })

  describe('never leaves a half applied skeleton', () => {
    it('rejects unsupported results and invalid positions without touching the skeleton', async () => {
      const { skeleton } = await load_human_rig_skeleton()
      const before = snapshot_world(skeleton)
      const applicator = new JointPoseApplicator()

      expect(() => applicator.plan(skeleton, { ...make_result(a_pose_targets(skeleton)), status: 'unsupported' })).toThrow()

      const invalid = a_pose_targets(skeleton)
      invalid.knee_l = [NaN, 0, 0]
      expect(() => applicator.plan(skeleton, make_result(invalid))).toThrow(/invalid position/)

      expect(snapshot_world(skeleton)).toEqual(before)
    })

    it('rejects a skeleton that is not the human rig', async () => {
      const { skeleton } = await load_human_rig_skeleton()
      const result = make_result(a_pose_targets(skeleton))
      skeleton.bones.forEach((bone) => { bone.name = `fox_${bone.name}` })
      const applicator = new JointPoseApplicator()

      expect(() => applicator.plan(skeleton, result)).toThrow(/does not match/)
    })

    it('restores the skeleton if applying fails half way', async () => {
      const { skeleton } = await load_human_rig_skeleton()
      const before = snapshot_world(skeleton)
      const applicator = new JointPoseApplicator()
      const plan = applicator.plan(skeleton, make_result(a_pose_targets(skeleton)))
      plan.targets[plan.targets.length - 1].world_position.set(Infinity, 0, 0) // corrupt the last bone

      expect(() => applicator.apply(skeleton, plan)).toThrow()
      snapshot_world(skeleton).forEach((position, name) => {
        expect(position.distanceTo(before.get(name) as Vector3), name).toBeLessThan(1e-6)
      })
    })
  })

  it('changes the pelvis offset in proportion to the new pelvis height (used to scale animation position keyframes)', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const pelvis = bone_named(skeleton, 'pelvis')
    const loaded_offset = pelvis.position.length()
    const loaded_height = world(pelvis).y

    // a smaller character, standing on the same floor
    const targets: Partial<Record<HumanJointId, Vec3Tuple>> = {}
    HUMAN_JOINT_IDS.forEach((id) => {
      targets[id] = rig_position(skeleton, id).multiplyScalar(0.63).toArray() as Vec3Tuple
    })
    const applicator = new JointPoseApplicator()
    applicator.apply(skeleton, applicator.plan(skeleton, make_result(targets)))

    expect(pelvis.position.length() / loaded_offset).toBeCloseTo(world(pelvis).y / loaded_height, 2)
    expect(pelvis.position.length() / loaded_offset).toBeCloseTo(0.63, 2)
  })

  it('is a single undo step with the existing UndoRedoSystem', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const undo_redo = new UndoRedoSystem()
    undo_redo.set_skeleton(skeleton)

    const before = snapshot_world(skeleton)
    const applicator = new JointPoseApplicator()
    const plan = applicator.plan(skeleton, make_result(a_pose_targets(skeleton)))
    undo_redo.store_current_state()
    applicator.apply(skeleton, plan)
    const after = snapshot_world(skeleton)

    expect(undo_redo.get_undo_count()).toBe(1)

    expect(undo_redo.undo()).toBe(true)
    snapshot_world(skeleton).forEach((position, name) => {
      expect(position.distanceTo(before.get(name) as Vector3), name).toBeLessThan(1e-5)
    })

    expect(undo_redo.redo()).toBe(true)
    snapshot_world(skeleton).forEach((position, name) => {
      expect(position.distanceTo(after.get(name) as Vector3), name).toBeLessThan(1e-5)
    })
  })
})
