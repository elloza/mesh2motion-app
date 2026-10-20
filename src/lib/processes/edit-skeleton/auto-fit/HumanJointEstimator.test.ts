import { describe, it, expect } from 'vitest'
import { BoxGeometry, Euler, Matrix4, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three'
import { HumanJointEstimator } from './HumanJointEstimator'
import { GeometrySampler } from './GeometrySampler'
import {
  AutoFitAbortedError,
  DEFAULT_AUTO_FIT_OPTIONS,
  HUMAN_JOINT_IDS,
  type AutoFitOptions,
  type AutoFitResult,
  type HumanJointId
} from './AutoFitTypes'
import {
  ADULT_PROPORTIONS,
  CHIBI_PROPORTIONS,
  build_synthetic_humanoid,
  type SyntheticHumanoid,
  type SyntheticHumanoidOptions
} from './test-fixtures/SyntheticHumanoid'
import { read_glb_meshes } from './test-fixtures/GlbMeshReader'

const MAJOR_JOINTS: HumanJointId[] = [
  'pelvis', 'neck', 'head',
  'shoulder_l', 'elbow_l', 'wrist_l', 'fingertip_l', 'shoulder_r', 'elbow_r', 'wrist_r', 'fingertip_r',
  'hip_l', 'knee_l', 'ankle_l', 'hip_r', 'knee_r', 'ankle_r'
]

async function fit (humanoid: SyntheticHumanoid, options: Partial<AutoFitOptions> = {}): Promise<AutoFitResult> {
  return await new HumanJointEstimator().estimate(GeometrySampler.sample(humanoid.root), { ...DEFAULT_AUTO_FIT_OPTIONS, ...options })
}

function joint_position (result: AutoFitResult, id: HumanJointId): Vector3 {
  const joint = result.joints.find(candidate => candidate.id === id)
  if (joint === undefined) { throw new Error(`missing joint ${id}`) }
  return new Vector3(...joint.world_position)
}

/** error of each major joint, as a fraction of the body height */
function relative_errors (result: AutoFitResult, humanoid: SyntheticHumanoid): Map<HumanJointId, number> {
  const errors = new Map<HumanJointId, number>()
  MAJOR_JOINTS.forEach((id) => {
    const truth = humanoid.truth[id]
    if (truth !== undefined) {
      errors.set(id, joint_position(result, id).distanceTo(truth) / humanoid.height)
    }
  })
  return errors
}

function expect_accurate (result: AutoFitResult, humanoid: SyntheticHumanoid, max_error: number, max_mean_error: number): void {
  const errors = relative_errors(result, humanoid)
  errors.forEach((error, id) => {
    expect(error, `${id} error ${error.toFixed(3)}`).toBeLessThan(max_error)
  })
  const mean = [...errors.values()].reduce((sum, error) => sum + error, 0) / errors.size
  expect(mean).toBeLessThan(max_mean_error)
}

const fixtures: Array<[string, SyntheticHumanoidOptions, 't-pose' | 'a-pose']> = [
  ['adult T-pose', {}, 't-pose'],
  ['adult A-pose (45 degrees)', { arm_angle_degrees: 45 }, 'a-pose'],
  ['adult A-pose (60 degrees)', { arm_angle_degrees: 60 }, 'a-pose'],
  ['chibi T-pose', { proportions: CHIBI_PROPORTIONS }, 't-pose'],
  ['chibi A-pose', { proportions: CHIBI_PROPORTIONS, arm_angle_degrees: 40 }, 'a-pose']
]

describe('HumanJointEstimator', () => {
  describe.each(fixtures)('%s', (_name, fixture_options, expected_pose) => {
    it('fits all major joints within 4% of the height and classifies the pose', async () => {
      const humanoid = build_synthetic_humanoid(fixture_options)
      const result = await fit(humanoid)

      expect(result.status).toBe('success')
      expect(result.pose).toBe(expected_pose)
      expect(result.joints.map(joint => joint.id)).toEqual([...HUMAN_JOINT_IDS])
      expect_accurate(result, humanoid, 0.04, 0.02)
    })

    it('keeps elbows and wrists away from the torso, below or level with the shoulders', async () => {
      const result = await fit(build_synthetic_humanoid(fixture_options))
      ;(['l', 'r'] as const).forEach((side) => {
        const shoulder = joint_position(result, `shoulder_${side}`)
        const elbow = joint_position(result, `elbow_${side}`)
        const wrist = joint_position(result, `wrist_${side}`)
        expect(Math.abs(elbow.x)).toBeGreaterThan(Math.abs(shoulder.x))
        expect(Math.abs(wrist.x)).toBeGreaterThan(Math.abs(elbow.x))
        expect(elbow.y).toBeLessThanOrEqual(shoulder.y + 0.01)
        expect(wrist.y).toBeLessThanOrEqual(elbow.y + 0.01)
      })
    })
  })

  it('puts left joints on +X and right joints on -X (never swaps sides)', async () => {
    const result = await fit(build_synthetic_humanoid({ arm_angle_degrees: 30 }))
    result.joints.filter(joint => joint.id.endsWith('_l')).forEach((joint) => {
      expect(joint.world_position[0], joint.id).toBeGreaterThan(0)
    })
    result.joints.filter(joint => joint.id.endsWith('_r')).forEach((joint) => {
      expect(joint.world_position[0], joint.id).toBeLessThan(0)
    })
  })

  it('works in world space when the model has a non trivial root transform', async () => {
    const root_transform = new Matrix4().compose(new Vector3(30, 5, -12), new Quaternion(), new Vector3(100, 100, 100))
    const humanoid = build_synthetic_humanoid({ arm_angle_degrees: 45, root_transform })
    const result = await fit(humanoid)

    expect(result.status).toBe('success')
    expect_accurate(result, humanoid, 0.04, 0.02)
  })

  it('puts the wrist where the arm is narrowest, not in the palm', async () => {
    for (const proportions of [ADULT_PROPORTIONS, { ...ADULT_PROPORTIONS, hand_width: 0.09, hand_thickness: 0.012 }]) {
      const humanoid = build_synthetic_humanoid({ proportions })
      const result = await fit(humanoid)
      const wrist = joint_position(result, 'wrist_l')
      const truth = humanoid.truth.wrist_l as Vector3

      expect(result.joints.find(joint => joint.id === 'wrist_l')?.method).toBe('measured')
      expect(wrist.distanceTo(truth) / humanoid.height).toBeLessThan(0.025)
      // never past the real wrist, towards the fingers
      expect(wrist.x).toBeLessThan(truth.x + 0.005 * humanoid.height)
    }
  })

  it('returns confidences between 0 and 1 and is deterministic', async () => {
    const humanoid = build_synthetic_humanoid({ arm_angle_degrees: 45 })
    const first = await fit(humanoid)
    const second = await fit(humanoid)

    first.joints.forEach((joint) => {
      expect(joint.confidence).toBeGreaterThanOrEqual(0)
      expect(joint.confidence).toBeLessThanOrEqual(1)
    })
    expect(second.joints).toEqual(first.joints)
    expect(second.status).toBe(first.status)
  })

  it('does not modify the analyzed model', async () => {
    const humanoid = build_synthetic_humanoid()
    const before: number[][] = []
    humanoid.root.traverse((object) => {
      if ((object as Mesh).isMesh === true) {
        before.push(Array.from((object as Mesh).geometry.getAttribute('position').array))
      }
    })
    await fit(humanoid)
    const after: number[][] = []
    humanoid.root.traverse((object) => {
      if ((object as Mesh).isMesh === true) {
        after.push(Array.from((object as Mesh).geometry.getAttribute('position').array))
      }
    })
    expect(after).toEqual(before)
  })

  it('fits the sample human model shipped with Mesh2Motion (T-pose mannequin)', async () => {
    const result = await new HumanJointEstimator().estimate(GeometrySampler.sample(read_glb_meshes('static/models/model-human.glb')))
    const height = result.diagnostics.height as number
    const at = (id: HumanJointId): Vector3 => joint_position(result, id).divideScalar(height)

    expect(result.status).toBe('success')
    expect(result.pose).toBe('t-pose')
    ;(['l', 'r'] as const).forEach((side) => {
      const sign = side === 'l' ? 1 : -1
      // laterality and plausible landmarks for this mannequin (heights as a fraction of its height)
      // the mannequin's forearm is narrowest at x ~ 0.40 of its height
      expect(at(`wrist_${side}`).x * sign).toBeGreaterThan(0.37)
      expect(at(`wrist_${side}`).x * sign).toBeLessThan(0.42)
      expect(at(`shoulder_${side}`).x * sign).toBeGreaterThan(0.06)
      expect(at(`ankle_${side}`).y).toBeLessThan(0.07)
      expect(at(`hip_${side}`).y).toBeGreaterThan(0.45)
      expect(at(`hip_${side}`).y).toBeLessThan(0.58)
    })
    // neck_01 at shoulder height, head bone just above the chin, head_leaf inside the head
    expect(Math.abs(at('neck').y - at('shoulder_l').y)).toBeLessThan(0.02)
    expect(at('head').y).toBeGreaterThan(0.86)
    expect(at('head_top').y).toBeGreaterThan(at('head').y)
    expect(at('head_top').y).toBeLessThan(0.97)
  })

  it('gives the same skeleton for the T-pose and A-pose versions of the sample mannequin', async () => {
    // static/test-files/bone-correction-tests/human-a-pose.glb is the same mannequin with the arms lowered
    const t_pose = await new HumanJointEstimator().estimate(GeometrySampler.sample(read_glb_meshes('static/models/model-human.glb')))
    const a_pose = await new HumanJointEstimator().estimate(GeometrySampler.sample(read_glb_meshes('static/test-files/bone-correction-tests/human-a-pose.glb')))
    const height = t_pose.diagnostics.height as number

    expect(a_pose.status).toBe('success')
    expect(a_pose.pose).toBe('a-pose')

    // nothing but the arms moved, so the rest of the skeleton must match
    const unchanged: HumanJointId[] = ['pelvis', 'neck', 'head', 'hip_l', 'knee_l', 'ankle_l', 'hip_r', 'knee_r', 'ankle_r']
    unchanged.forEach((id) => {
      expect(joint_position(a_pose, id).distanceTo(joint_position(t_pose, id)) / height, id).toBeLessThan(0.02)
    })
    // shoulders come from the arm line, which shifts a little (mostly in depth) when the arm is lowered
    ;(['shoulder_l', 'shoulder_r'] as HumanJointId[]).forEach((id) => {
      expect(joint_position(a_pose, id).distanceTo(joint_position(t_pose, id)) / height, id).toBeLessThan(0.03)
    })

    // the arms rotate around the shoulder, so arm lengths should stay close. Not
    // exact: the A-pose file was posed separately and its forearm deforms a bit
    const length = (result: AutoFitResult, from: HumanJointId, to: HumanJointId): number =>
      joint_position(result, from).distanceTo(joint_position(result, to))
    ;(['l', 'r'] as const).forEach((side) => {
      const ratio = length(a_pose, `shoulder_${side}`, `wrist_${side}`) / length(t_pose, `shoulder_${side}`, `wrist_${side}`)
      expect(Math.abs(ratio - 1)).toBeLessThan(0.08)
      expect(joint_position(a_pose, `wrist_${side}`).y).toBeLessThan(joint_position(a_pose, `elbow_${side}`).y)
    })
  })

  describe('incomplete or unusual models', () => {
    it('reports a missing leg as partial and mirrors the other leg', async () => {
      const result = await fit(build_synthetic_humanoid({ omit: ['left_leg'] }))

      expect(result.status).toBe('partial')
      expect(result.warnings.join(' ')).toMatch(/left leg was not found/)
      const left_knee = result.joints.find(joint => joint.id === 'knee_l')
      expect(left_knee?.method).toBe('mirrored')
    })

    it('does not report success for a model without head', async () => {
      const result = await fit(build_synthetic_humanoid({ omit: ['head'] }))

      expect(result.status).not.toBe('success')
      expect(result.warnings.join(' ')).toMatch(/No head/)
    })

    it('reports missing arms as partial with low confidence arm joints', async () => {
      const result = await fit(build_synthetic_humanoid({ omit: ['arms'] }))

      expect(result.status).toBe('partial')
      expect(result.joints.find(joint => joint.id === 'wrist_l')?.confidence).toBeLessThan(0.45)
    })

    it('keeps the other joints accurate and lowers confidence when holding a prop', async () => {
      const humanoid = build_synthetic_humanoid({ with_sword: true })
      const result = await fit(humanoid)

      expect(result.status).not.toBe('unsupported')
      const errors = relative_errors(result, humanoid)
      ;(['pelvis', 'neck', 'shoulder_l', 'elbow_l', 'wrist_l', 'hip_l', 'knee_r', 'ankle_r'] as HumanJointId[]).forEach((id) => {
        expect(errors.get(id), id).toBeLessThan(0.04)
      })
      // the arm holding the sword is flagged instead of silently trusted
      const right_wrist = result.joints.find(joint => joint.id === 'wrist_r')
      expect(right_wrist?.confidence).toBeLessThan(0.75)
    })

    it('flags a model rotated away from the front as partial', async () => {
      const result = await fit(build_synthetic_humanoid({ root_transform: new Matrix4().makeRotationY(0.17) }))

      expect(result.status).toBe('partial')
      expect(result.warnings.join(' ')).toMatch(/rotated or posed asymmetrically/)
    })

    it('refuses models that face backwards', async () => {
      const result = await fit(build_synthetic_humanoid({ root_transform: new Matrix4().makeRotationFromEuler(new Euler(0, Math.PI, 0)) }))

      expect(result.status).toBe('unsupported')
      expect(result.joints).toEqual([])
    })

    it('refuses shapes that are not humanoids', async () => {
      const material = new MeshBasicMaterial()
      const sphere = await new HumanJointEstimator().estimate(GeometrySampler.sample(new Mesh(new SphereGeometry(1, 32, 16), material)))
      const panel = await new HumanJointEstimator().estimate(GeometrySampler.sample(new Mesh(new BoxGeometry(1, 1.8, 0.3), material)))

      expect(sphere.status).toBe('unsupported')
      expect(panel.status).toBe('unsupported')
      expect(panel.joints).toEqual([])
    })
  })

  describe('options', () => {
    it('warns when the selected pose does not match the detected one', async () => {
      const result = await fit(build_synthetic_humanoid({ arm_angle_degrees: 45 }), { pose_mode: 't-pose' })

      expect(result.pose).toBe('t-pose')
      expect(result.warnings.join(' ')).toMatch(/look like an A-pose/)
    })

    it('keeps each side independent when symmetry is off', async () => {
      const humanoid = build_synthetic_humanoid({ root_transform: new Matrix4().makeRotationY(0.17) })
      const symmetric = await fit(humanoid, { use_symmetry: true })
      const independent = await fit(humanoid, { use_symmetry: false })

      const left_wrist_with = joint_position(symmetric, 'wrist_l')
      const right_wrist_with = joint_position(symmetric, 'wrist_r')
      expect(left_wrist_with.z).toBeCloseTo(right_wrist_with.z, 5)

      // independent sides follow the actual (rotated) geometry, so they end up more accurate
      const errors_independent = relative_errors(independent, humanoid)
      const errors_symmetric = relative_errors(symmetric, humanoid)
      expect(errors_independent.get('wrist_l')).toBeLessThan(errors_symmetric.get('wrist_l') as number)
    })

    it('can be cancelled before or while running', async () => {
      const snapshot = GeometrySampler.sample(build_synthetic_humanoid().root)

      const aborted_before = new AbortController()
      aborted_before.abort()
      await expect(new HumanJointEstimator().estimate(snapshot, DEFAULT_AUTO_FIT_OPTIONS, aborted_before.signal))
        .rejects.toBeInstanceOf(AutoFitAbortedError)

      // the estimator yields between stages, so an abort right after starting is honoured
      const aborted_while_running = new AbortController()
      const pending = new HumanJointEstimator().estimate(snapshot, DEFAULT_AUTO_FIT_OPTIONS, aborted_while_running.signal)
      aborted_while_running.abort()
      await expect(pending).rejects.toBeInstanceOf(AutoFitAbortedError)
    })
  })
})
