import { describe, it, expect } from 'vitest'
import { FitConstraintSolver, type SolverContext } from './FitConstraintSolver'
import { BodySliceProfile } from './BodySliceProfile'
import {
  DEFAULT_AUTO_FIT_OPTIONS,
  HUMAN_JOINT_IDS,
  type HumanJointId,
  type JointEstimate,
  type Vec3Tuple
} from './AutoFitTypes'

// a plausible standing T-pose skeleton, 1.8 units tall, centred on x = 0
const VALID_POSITIONS: Record<HumanJointId, Vec3Tuple> = {
  pelvis: [0, 0.93, 0],
  spine_lower: [0, 1.04, 0],
  spine_middle: [0, 1.17, 0],
  spine_upper: [0, 1.32, 0],
  neck: [0, 1.5, 0],
  head: [0, 1.58, 0],
  head_top: [0, 1.7, 0],
  clavicle_l: [0.03, 1.42, 0.05],
  shoulder_l: [0.2, 1.44, 0],
  elbow_l: [0.5, 1.44, 0],
  wrist_l: [0.77, 1.44, 0],
  clavicle_r: [-0.03, 1.42, 0.05],
  shoulder_r: [-0.2, 1.44, 0],
  elbow_r: [-0.5, 1.44, 0],
  wrist_r: [-0.77, 1.44, 0],
  hip_l: [0.11, 0.94, 0],
  knee_l: [0.11, 0.5, 0],
  ankle_l: [0.11, 0.09, 0],
  ball_l: [0.11, 0.03, 0.15],
  toe_l: [0.11, 0.02, 0.23],
  hip_r: [-0.11, 0.94, 0],
  knee_r: [-0.11, 0.5, 0],
  ankle_r: [-0.11, 0.09, 0],
  ball_r: [-0.11, 0.03, 0.15],
  toe_r: [-0.11, 0.02, 0.23]
}

function valid_joints (): Partial<Record<HumanJointId, JointEstimate>> {
  const joints: Partial<Record<HumanJointId, JointEstimate>> = {}
  HUMAN_JOINT_IDS.forEach((id) => {
    joints[id] = { id, world_position: [...VALID_POSITIONS[id]], confidence: 0.85, method: 'measured', warnings: [] }
  })
  return joints
}

// the surface "samples" are the joints themselves, so every joint touches the surface
function context (overrides: Partial<SolverContext> = {}): SolverContext {
  const points = new Float32Array(HUMAN_JOINT_IDS.flatMap(id => VALID_POSITIONS[id]))
  return {
    snapshot: { points, point_count: HUMAN_JOINT_IDS.length, bounds_min: [-0.8, 0, -0.1], bounds_max: [0.8, 1.8, 0.25], source_mesh_count: 1, source_triangle_count: 1 },
    frame: { floor_y: 0, top_y: 1.8, height: 1.8, width: 1.6, depth: 0.35, center_x: 0, center_z: 0, facing: 'front', facing_confidence: 1 },
    options: DEFAULT_AUTO_FIT_OPTIONS,
    required_parts_found: { head: true, arm_l: true, arm_r: true, leg_l: true, leg_r: true },
    ...overrides
  }
}

describe('FitConstraintSolver', () => {
  it('accepts a consistent skeleton as success', () => {
    const result = FitConstraintSolver.solve(valid_joints(), context())

    expect(result.status).toBe('success')
    expect(result.joints.map(joint => joint.id)).toEqual([...HUMAN_JOINT_IDS])
    expect(result.warnings).toEqual([])
  })

  it('does not modify its input', () => {
    const input = valid_joints()
    ;(input.knee_l as JointEstimate).world_position = [0.11, 1.2, 0] // gives the solver something to penalize
    ;(input.elbow_l as JointEstimate).world_position = [0.52, 1.46, 0.02] // and something to symmetrize
    const input_copy = structuredClone(input)

    FitConstraintSolver.solve(input, context())
    expect(input).toEqual(input_copy)
  })

  it('reports a knee above the hip as partial and lowers its confidence', () => {
    const joints = valid_joints()
    ;(joints.knee_l as JointEstimate).world_position = [0.11, 1.0, 0]
    ;(joints.knee_r as JointEstimate).world_position = [-0.11, 1.0, 0]

    const result = FitConstraintSolver.solve(joints, context())
    const knee = result.joints.find(joint => joint.id === 'knee_l')

    expect(result.status).toBe('partial')
    expect(result.warnings).toContain('The left leg joints are out of order.')
    expect(knee?.confidence).toBeLessThan(0.45)
    expect(result.warnings).toContain('Left knee may be inaccurate.')
  })

  it('reports arm joints folding back towards the body', () => {
    const joints = valid_joints()
    ;(joints.wrist_l as JointEstimate).world_position = [0.3, 1.44, 0]
    ;(joints.wrist_r as JointEstimate).world_position = [-0.3, 1.44, 0]

    const result = FitConstraintSolver.solve(joints, context())
    expect(result.status).toBe('partial')
    expect(result.warnings).toContain('The left arm joints are out of order.')
  })

  it('mirrors a side that could not be measured, and keeps the result partial', () => {
    const joints = valid_joints()
    const fallback_wrist = joints.wrist_r as JointEstimate
    fallback_wrist.method = 'fallback'
    fallback_wrist.confidence = 0.25
    fallback_wrist.world_position = [-0.3, 1.0, 0.4]

    const result = FitConstraintSolver.solve(joints, context())
    const wrist = result.joints.find(joint => joint.id === 'wrist_r')

    expect(wrist?.method).toBe('mirrored')
    expect(wrist?.world_position).toEqual([-0.77, 1.44, 0])
    expect(result.status).toBe('partial')
  })

  it('averages both sides when symmetry is on, and leaves them alone when it is off', () => {
    const joints = valid_joints()
    ;(joints.elbow_l as JointEstimate).world_position = [0.52, 1.46, 0.02]

    const symmetric = FitConstraintSolver.solve(joints, context())
    const left = symmetric.joints.find(joint => joint.id === 'elbow_l')?.world_position as Vec3Tuple
    const right = symmetric.joints.find(joint => joint.id === 'elbow_r')?.world_position as Vec3Tuple
    expect(left[0]).toBeCloseTo(-right[0], 6)
    expect(left[1]).toBeCloseTo(right[1], 6)
    expect(left[0]).toBeCloseTo(0.51, 6)

    const independent = FitConstraintSolver.solve(joints, context({ options: { ...DEFAULT_AUTO_FIT_OPTIONS, use_symmetry: false } }))
    expect(independent.joints.find(joint => joint.id === 'elbow_l')?.world_position).toEqual([0.52, 1.46, 0.02])
    expect(independent.joints.find(joint => joint.id === 'elbow_r')?.world_position).toEqual([-0.5, 1.44, 0])
  })

  it('lowers the confidence of limb joints floating far away from the mesh', () => {
    const joints = valid_joints()
    ;(joints.ankle_l as JointEstimate).world_position = [0.6, 0.3, 0.5]
    ;(joints.ankle_r as JointEstimate).world_position = [-0.6, 0.3, 0.5]

    const result = FitConstraintSolver.solve(joints, context())
    const ankle = result.joints.find(joint => joint.id === 'ankle_l')
    expect(ankle?.warnings).toContain('Far away from the mesh surface')
    expect(ankle?.confidence).toBeLessThan(0.5)
  })

  it('is unsupported when no limbs were found at all', () => {
    const result = FitConstraintSolver.solve(valid_joints(), context({
      required_parts_found: { head: true, arm_l: false, arm_r: false, leg_l: false, leg_r: false }
    }))
    expect(result.status).toBe('unsupported')
    expect(result.joints).toEqual([])
  })

  it('is partial when the head was not found', () => {
    const result = FitConstraintSolver.solve(valid_joints(), context({
      required_parts_found: { head: false, arm_l: true, arm_r: true, leg_l: true, leg_r: true }
    }))
    expect(result.status).toBe('partial')
  })

  it('is unsupported when a joint estimate is missing', () => {
    const joints = valid_joints()
    delete joints.knee_l
    expect(FitConstraintSolver.solve(joints, context()).status).toBe('unsupported')
  })

  it('keeps every confidence between 0 and 1', () => {
    const joints = valid_joints()
    ;(joints.pelvis as JointEstimate).confidence = 3
    ;(joints.neck as JointEstimate).confidence = -1
    const result = FitConstraintSolver.solve(joints, context())
    result.joints.forEach((joint) => {
      expect(joint.confidence).toBeGreaterThanOrEqual(0)
      expect(joint.confidence).toBeLessThanOrEqual(1)
    })
  })

  it('formats readable joint labels', () => {
    expect(FitConstraintSolver.joint_label('wrist_r')).toBe('Right wrist')
    expect(FitConstraintSolver.joint_label('ball_l')).toBe('Left ball of foot')
    expect(FitConstraintSolver.joint_label('pelvis')).toBe('Pelvis')
  })
})

describe('BodySliceProfile.cluster_along_x', () => {
  it('splits points where the gap along X is larger than the threshold', () => {
    // x values: two legs around -0.1 and +0.1, separated by a 0.12 gap
    const xs = [-0.14, -0.12, -0.1, -0.08, 0.08, 0.1, 0.12, 0.14]
    const points = new Float32Array(xs.flatMap(x => [x, 0, 0]))
    const clusters = BodySliceProfile.cluster_along_x(points, xs.map((_, i) => i), 0.05)

    expect(clusters).toHaveLength(2)
    expect(clusters[0].mean_x).toBeCloseTo(-0.11, 5)
    expect(clusters[1].mean_x).toBeCloseTo(0.11, 5)
    expect(clusters[0].count).toBe(4)
  })

  it('returns no clusters for an empty slice', () => {
    expect(BodySliceProfile.cluster_along_x(new Float32Array(0), [], 0.05)).toEqual([])
  })
})
