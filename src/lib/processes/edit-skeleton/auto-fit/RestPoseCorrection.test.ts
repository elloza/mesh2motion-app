import { describe, it, expect } from 'vitest'
import { AnimationClip, AnimationMixer, Quaternion, QuaternionKeyframeTrack, Vector3, type Bone, type Skeleton } from 'three'
import { RestPoseCorrection } from './RestPoseCorrection'
import { JointPoseApplicator, MESH2MOTION_HUMAN_BONE_MAP, estimate_rig_fingertip } from './JointPoseApplicator'
import { HUMAN_JOINT_IDS, type AutoFitResult, type HumanJointId, type Vec3Tuple } from './AutoFitTypes'
import { load_human_rig_skeleton } from './test-fixtures/HumanRigLoader'

function world (bone: Bone): Vector3 {
  bone.updateWorldMatrix(true, false)
  return bone.getWorldPosition(new Vector3())
}

function bone_named (skeleton: Skeleton, name: string): Bone {
  return skeleton.bones.find(bone => bone.name === name) as Bone
}

// the current rig joints, with the left forearm and hand bent 45 degrees forward (like some generated models)
function bent_forearm_result (skeleton: Skeleton): AutoFitResult {
  const position_of = (id: HumanJointId): Vector3 => id.startsWith('fingertip')
    ? estimate_rig_fingertip(bone_named(skeleton, `hand_${id.slice(-1)}`), world) as Vector3
    : world(bone_named(skeleton, MESH2MOTION_HUMAN_BONE_MAP[id] as string))
  const elbow = position_of('elbow_l')
  const bend = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 4) // +X towards +Z
  const joints = HUMAN_JOINT_IDS.map((id) => {
    let position = position_of(id)
    if (id === 'wrist_l' || id === 'fingertip_l') {
      position = position.sub(elbow).applyQuaternion(bend).add(elbow)
    }
    return { id, world_position: position.toArray() as Vec3Tuple, confidence: 0.8, method: 'measured' as const, warnings: [] }
  })
  return { status: 'success', pose: 't-pose', joints, warnings: [], diagnostics: {} }
}

describe('RestPoseCorrection', () => {
  it('has no corrections when nothing changed direction', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const directions = RestPoseCorrection.child_directions(skeleton)
    expect(RestPoseCorrection.compute(directions, skeleton).by_bone.size).toBe(0)
  })

  it('corrects the bones whose direction changed, and leaves pelvis and spine alone', async () => {
    const { skeleton } = await load_human_rig_skeleton()
    const directions = RestPoseCorrection.child_directions(skeleton)
    const applicator = new JointPoseApplicator()
    applicator.apply(skeleton, applicator.plan(skeleton, bent_forearm_result(skeleton)))

    const corrections = RestPoseCorrection.compute(directions, skeleton)
    expect(corrections.by_bone.has('lowerarm_l')).toBe(true)
    expect(corrections.by_bone.has('lowerarm_r')).toBe(false)
    expect([...corrections.by_bone.keys()].some(name => /^(pelvis|spine_)/.test(name))).toBe(false)
    expect(2 * Math.acos(Math.min(1, Math.abs((corrections.by_bone.get('lowerarm_l') as Quaternion).w))) * 180 / Math.PI).toBeCloseTo(45, 0)
  })

  it('makes an animated bent forearm point where the template animation intends', async () => {
    const template = await load_human_rig_skeleton()
    const fitted = await load_human_rig_skeleton()
    const directions = RestPoseCorrection.child_directions(fitted.skeleton)
    const applicator = new JointPoseApplicator()
    applicator.apply(fitted.skeleton, applicator.plan(fitted.skeleton, bent_forearm_result(fitted.skeleton)))
    const corrections = RestPoseCorrection.compute(directions, fitted.skeleton)

    // an animation that bends the elbow 60 degrees
    const lowerarm = bone_named(template.skeleton, 'lowerarm_l')
    const bent = lowerarm.quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3))
    const make_clip = (): AnimationClip => new AnimationClip('bend', 1, [
      new QuaternionKeyframeTrack('lowerarm_l.quaternion', [0, 1], [...bent.toArray(), ...bent.toArray()])
    ])
    const play = (armature: typeof template.armature, clip: AnimationClip): void => {
      const mixer = new AnimationMixer(armature)
      mixer.clipAction(clip).play()
      mixer.setTime(0.5)
      armature.updateMatrixWorld(true)
    }

    play(template.armature, make_clip())
    const corrected_clip = make_clip()
    RestPoseCorrection.apply_to_clips([corrected_clip], corrections)
    play(fitted.armature, corrected_clip)

    const forearm_direction = (skeleton: Skeleton): Vector3 =>
      world(bone_named(skeleton, 'hand_l')).sub(world(bone_named(skeleton, 'lowerarm_l'))).normalize()
    expect(forearm_direction(fitted.skeleton).angleTo(forearm_direction(template.skeleton))).toBeLessThan(0.01)
  })

  it('keeps a whole chain matching the template when parent and child both changed direction (A-pose arm)', async () => {
    const template = await load_human_rig_skeleton()
    const fitted = await load_human_rig_skeleton()
    const directions = RestPoseCorrection.child_directions(fitted.skeleton)

    // lower the whole left arm 40 degrees (A-pose) and bend the forearm forward on top
    const result = bent_forearm_result(fitted.skeleton)
    const shoulder = new Vector3(...(result.joints.find(joint => joint.id === 'shoulder_l')?.world_position as Vec3Tuple))
    const lower = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -40 * Math.PI / 180)
    result.joints.forEach((joint) => {
      if (['elbow_l', 'wrist_l', 'fingertip_l'].includes(joint.id)) {
        joint.world_position = new Vector3(...joint.world_position).sub(shoulder).applyQuaternion(lower).add(shoulder).toArray() as Vec3Tuple
      }
    })
    const applicator = new JointPoseApplicator()
    applicator.apply(fitted.skeleton, applicator.plan(fitted.skeleton, result))
    const corrections = RestPoseCorrection.compute(directions, fitted.skeleton)

    // animate shoulder, elbow and wrist at once
    const tracks = ['upperarm_l', 'lowerarm_l', 'hand_l'].map((name, k) => {
      const value = bone_named(template.skeleton, name).quaternion.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0.3 * k, 0).normalize(), 0.4 + 0.3 * k))
      return new QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [...value.toArray(), ...value.toArray()])
    })
    const play = (armature: typeof template.armature, clip: AnimationClip): void => {
      const mixer = new AnimationMixer(armature)
      mixer.clipAction(clip).play()
      mixer.setTime(0.5)
      armature.updateMatrixWorld(true)
    }
    play(template.armature, new AnimationClip('arm', 1, tracks.map(track => track.clone())))
    const corrected = new AnimationClip('arm', 1, tracks.map(track => track.clone()))
    RestPoseCorrection.apply_to_clips([corrected], corrections)
    play(fitted.armature, corrected)

    const direction = (skeleton: Skeleton, from: string, to: string): Vector3 =>
      world(bone_named(skeleton, to)).sub(world(bone_named(skeleton, from))).normalize()
    expect(direction(fitted.skeleton, 'upperarm_l', 'lowerarm_l').angleTo(direction(template.skeleton, 'upperarm_l', 'lowerarm_l'))).toBeLessThan(0.01)
    expect(direction(fitted.skeleton, 'lowerarm_l', 'hand_l').angleTo(direction(template.skeleton, 'lowerarm_l', 'hand_l'))).toBeLessThan(0.01)
    expect(direction(fitted.skeleton, 'hand_l', 'middle_01_l').angleTo(direction(template.skeleton, 'hand_l', 'middle_01_l'))).toBeLessThan(0.01)
  })
})
