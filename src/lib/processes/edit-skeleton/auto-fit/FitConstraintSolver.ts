import {
  CRITICAL_JOINT_IDS,
  HUMAN_JOINT_IDS,
  LOW_CONFIDENCE_THRESHOLD,
  type AutoFitOptions,
  type AutoFitStatus,
  type GeometrySnapshot,
  type HumanJointId,
  type JointEstimate,
  type Vec3Tuple
} from './AutoFitTypes.ts'
import { type BodyFrame } from './BodyFrameEstimator.ts'

export interface SolverContext {
  snapshot: GeometrySnapshot
  frame: BodyFrame
  options: AutoFitOptions
  required_parts_found: { head: boolean, arm_l: boolean, arm_r: boolean, leg_l: boolean, leg_r: boolean }
}

export interface SolverResult {
  status: AutoFitStatus
  joints: JointEstimate[]
  warnings: string[]
  diagnostics: Record<string, number | string | boolean>
}

// joints that come in left/right pairs. The base name gets _l / _r appended
const PAIRED_JOINTS = ['clavicle', 'shoulder', 'elbow', 'wrist', 'fingertip', 'hip', 'knee', 'ankle', 'ball', 'toe'] as const

const LIMB_JOINT_IDS: readonly HumanJointId[] = [
  'elbow_l', 'wrist_l', 'knee_l', 'ankle_l', 'ball_l', 'toe_l',
  'elbow_r', 'wrist_r', 'knee_r', 'ankle_r', 'ball_r', 'toe_r'
]

const JOINT_LABELS: Record<string, string> = {
  pelvis: 'Pelvis',
  spine_lower: 'Lower spine',
  spine_middle: 'Middle spine',
  spine_upper: 'Upper spine',
  neck: 'Neck',
  head: 'Head',
  head_top: 'Top of head',
  clavicle: 'clavicle',
  shoulder: 'shoulder',
  elbow: 'elbow',
  wrist: 'wrist',
  fingertip: 'finger tips',
  hip: 'hip',
  knee: 'knee',
  ankle: 'ankle',
  ball: 'ball of foot',
  toe: 'toes'
}

/*
 * FitConstraintSolver
 * Takes the raw joint proposals and makes them consistent:
 * - left/right symmetry (optional), and mirroring of a side that could not be measured
 * - anatomical order along each chain (hip above knee above ankle, etc.)
 * - plausible bone length ratios
 * - every joint has to be close to the mesh surface
 * Then it settles the final confidence of each joint and the overall status.
 * It never invents a "success": anything missing or contradictory makes the result partial.
 */
export class FitConstraintSolver {
  public static solve (raw_joints: Partial<Record<HumanJointId, JointEstimate>>, context: SolverContext): SolverResult {
    const h = context.frame.height
    const cx = context.frame.center_x
    const warnings: string[] = []
    const diagnostics: Record<string, number | string | boolean> = {}

    // work on copies, the input stays untouched
    const joints = new Map<HumanJointId, JointEstimate>()
    HUMAN_JOINT_IDS.forEach((id) => {
      const joint = raw_joints[id]
      if (joint !== undefined) {
        joints.set(id, { ...joint, world_position: [...joint.world_position], warnings: [...joint.warnings] })
      }
    })

    const missing = HUMAN_JOINT_IDS.filter(id => !joints.has(id))
    if (missing.length > 0) {
      return {
        status: 'unsupported',
        joints: [],
        warnings: [`Internal error: missing joint estimates (${missing.join(', ')}).`],
        diagnostics
      }
    }

    const get = (id: HumanJointId): JointEstimate => joints.get(id) as JointEstimate
    const penalize = (id: HumanJointId, factor: number, message?: string): void => {
      const joint = get(id)
      joint.confidence *= factor
      if (message !== undefined && !joint.warnings.includes(message)) {
        joint.warnings.push(message)
      }
    }

    // -- symmetry ----------------------------------------------------------
    let max_asymmetry = 0
    PAIRED_JOINTS.forEach((base) => {
      const left = get(`${base}_l`)
      const right = get(`${base}_r`)
      const left_is_weak = left.method === 'fallback'
      const right_is_weak = right.method === 'fallback'

      if (left_is_weak !== right_is_weak) {
        // one side could not be measured: copy the measured side across the centre line
        const [strong, weak] = left_is_weak ? [right, left] : [left, right]
        weak.world_position = FitConstraintSolver.mirror(strong.world_position, cx)
        weak.method = 'mirrored'
        weak.confidence = strong.confidence * 0.6
        weak.warnings.push('Copied from the opposite side')
        return
      }

      const mirrored_right = FitConstraintSolver.mirror(right.world_position, cx)
      const asymmetry = FitConstraintSolver.distance(left.world_position, mirrored_right) / h
      max_asymmetry = Math.max(max_asymmetry, asymmetry)
      if (asymmetry > 0.06) {
        penalize(left.id, 0.8, 'Left and right estimates disagree')
        penalize(right.id, 0.8, 'Left and right estimates disagree')
      }

      if (context.options.use_symmetry) {
        const total = Math.max(left.confidence + right.confidence, 1e-6)
        const wl = left.confidence / total
        const wr = right.confidence / total
        const averaged: Vec3Tuple = [
          left.world_position[0] * wl + mirrored_right[0] * wr,
          left.world_position[1] * wl + mirrored_right[1] * wr,
          left.world_position[2] * wl + mirrored_right[2] * wr
        ]
        left.world_position = averaged
        right.world_position = FitConstraintSolver.mirror(averaged, cx)
      }
    })
    diagnostics.max_asymmetry_ratio = Math.round(max_asymmetry * 1000) / 1000
    const is_strongly_asymmetric = max_asymmetry > 0.1
    if (max_asymmetry > 0.06) {
      warnings.push('Left and right sides do not match well. The model may be rotated or posed asymmetrically.')
    }

    // -- anatomical order --------------------------------------------------
    let has_violation = false
    const require_order = (condition: boolean, ids: HumanJointId[], message: string): void => {
      if (condition) { return }
      has_violation = true
      ids.forEach(id => { penalize(id, 0.5, message) })
      warnings.push(message)
    }
    const y = (id: HumanJointId): number => get(id).world_position[1]
    const lateral = (id: HumanJointId): number => Math.abs(get(id).world_position[0] - cx)
    const tolerance = 0.01 * h

    require_order(
      y('pelvis') < y('spine_lower') && y('spine_lower') < y('spine_middle') && y('spine_middle') < y('spine_upper') &&
        y('spine_upper') < y('neck') && y('neck') < y('head') && y('head') < y('head_top'),
      ['pelvis', 'spine_lower', 'spine_middle', 'spine_upper', 'neck', 'head', 'head_top'],
      'The spine joints are out of order.'
    )

    ;(['l', 'r'] as const).forEach((side) => {
      const name = side === 'l' ? 'left' : 'right'
      require_order(
        y(`hip_${side}`) > y(`knee_${side}`) && y(`knee_${side}`) > y(`ankle_${side}`) && y(`ankle_${side}`) > context.frame.floor_y,
        [`hip_${side}`, `knee_${side}`, `ankle_${side}`],
        `The ${name} leg joints are out of order.`
      )
      require_order(
        get(`toe_${side}`).world_position[2] > get(`ankle_${side}`).world_position[2] && y(`ball_${side}`) <= y(`ankle_${side}`) + tolerance,
        [`ball_${side}`, `toe_${side}`],
        `The ${name} foot does not point forward.`
      )
      require_order(
        lateral(`shoulder_${side}`) < lateral(`elbow_${side}`) && lateral(`elbow_${side}`) < lateral(`wrist_${side}`) &&
          lateral(`wrist_${side}`) < lateral(`fingertip_${side}`) &&
          y(`elbow_${side}`) <= y(`shoulder_${side}`) + 0.05 * h && y(`wrist_${side}`) <= y(`elbow_${side}`) + 0.05 * h,
        [`shoulder_${side}`, `elbow_${side}`, `wrist_${side}`, `fingertip_${side}`],
        `The ${name} arm joints are out of order.`
      )

      // bone length ratios
      const thigh = FitConstraintSolver.distance(get(`hip_${side}`).world_position, get(`knee_${side}`).world_position)
      const shin = FitConstraintSolver.distance(get(`knee_${side}`).world_position, get(`ankle_${side}`).world_position)
      if (shin > 0 && (thigh / shin < 0.6 || thigh / shin > 1.7)) {
        penalize(`knee_${side}`, 0.7, 'Unusual thigh/shin length ratio')
      }
      const upper_arm = FitConstraintSolver.distance(get(`shoulder_${side}`).world_position, get(`elbow_${side}`).world_position)
      const forearm = FitConstraintSolver.distance(get(`elbow_${side}`).world_position, get(`wrist_${side}`).world_position)
      if (forearm > 0 && (upper_arm / forearm < 0.6 || upper_arm / forearm > 1.8)) {
        penalize(`elbow_${side}`, 0.7, 'Unusual upper arm/forearm length ratio')
      }
    })

    // -- distance to the surface --------------------------------------------
    // limbs are thin, so a limb joint far away from any geometry is floating in
    // the air. Torso and head joints can legitimately be deep inside a big volume
    let total_surface_distance = 0
    LIMB_JOINT_IDS.forEach((id) => {
      const distance = FitConstraintSolver.nearest_surface_distance(get(id).world_position, context.snapshot)
      total_surface_distance += distance
      if (distance > 0.1 * h) {
        penalize(id, 0.5, 'Far away from the mesh surface')
      }
    })
    diagnostics.mean_limb_surface_distance_ratio = Math.round(total_surface_distance / LIMB_JOINT_IDS.length / h * 1000) / 1000

    // -- final confidence and status ----------------------------------------
    joints.forEach((joint) => {
      joint.confidence = Math.min(Math.max(joint.confidence, 0), 1)
    })

    CRITICAL_JOINT_IDS.forEach((id) => {
      const joint = get(id)
      if (joint.confidence < LOW_CONFIDENCE_THRESHOLD) {
        warnings.push(`${FitConstraintSolver.joint_label(id)} may be inaccurate.`)
      }
    })

    const parts = context.required_parts_found
    const no_limbs = !parts.arm_l && !parts.arm_r && !parts.leg_l && !parts.leg_r
    const critical_estimated = CRITICAL_JOINT_IDS.some(id => get(id).method === 'fallback' || get(id).method === 'mirrored')
    const critical_low = CRITICAL_JOINT_IDS.some(id => get(id).confidence < 0.3)

    let status: AutoFitStatus = 'success'
    if (no_limbs) {
      status = 'unsupported'
      warnings.push('No arms or legs were detected, so this does not look like a humanoid.')
    } else if (has_violation || critical_estimated || critical_low || is_strongly_asymmetric || !parts.head) {
      status = 'partial'
    }

    return {
      status,
      joints: status === 'unsupported' ? [] : HUMAN_JOINT_IDS.map(get),
      warnings,
      diagnostics
    }
  }

  public static joint_label (id: HumanJointId): string {
    const match = /^(.*)_(l|r)$/.exec(id)
    if (match === null) {
      return JOINT_LABELS[id] ?? id
    }
    const side = match[2] === 'l' ? 'Left' : 'Right'
    return `${side} ${JOINT_LABELS[match[1]] ?? match[1]}`
  }

  public static mirror (position: Vec3Tuple, center_x: number): Vec3Tuple {
    return [2 * center_x - position[0], position[1], position[2]]
  }

  public static distance (a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  }

  public static nearest_surface_distance (position: Vec3Tuple, snapshot: GeometrySnapshot): number {
    const points = snapshot.points
    let best = Infinity
    for (let i = 0; i < snapshot.point_count; i++) {
      const dx = points[i * 3] - position[0]
      const dy = points[i * 3 + 1] - position[1]
      const dz = points[i * 3 + 2] - position[2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < best) { best = d }
    }
    return Math.sqrt(best)
  }
}
