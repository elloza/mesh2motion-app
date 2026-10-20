import { Vector3 } from 'three'
import {
  AutoFitAbortedError,
  DEFAULT_AUTO_FIT_OPTIONS,
  type AutoFitOptions,
  type AutoFitResult,
  type DetectedPose,
  type GeometrySnapshot,
  type HumanJointId,
  type JointEstimate,
  type JointEstimator,
  type JointMethod
} from './AutoFitTypes.ts'
import { BodyFrameEstimator, type BodyFrame } from './BodyFrameEstimator.ts'
import { BodySliceProfile, type HorizontalSlice } from './BodySliceProfile.ts'
import { FitConstraintSolver } from './FitConstraintSolver.ts'
import { PointCloudUtils } from './PointCloudUtils.ts'

// starting confidence for each way of obtaining a joint, refined later by the solver
const BASE_CONFIDENCE: Record<JointMethod, number> = {
  measured: 0.85,
  proportional: 0.7,
  mirrored: 0.5,
  fallback: 0.25
}

// Body proportions only used to place joints between measured landmarks, or as
// a last resort. Ratios come from the Mesh2Motion human rig and common anthropometry.
const PROPORTIONS = {
  hip_above_crotch: 0.17, // fraction of crotch -> shoulder distance
  knee_between_ankle_and_hip: 0.5,
  elbow_between_shoulder_and_wrist: 0.54,
  wrist_along_arm: 0.74, // shoulder -> finger tip, used when the wrist can't be measured
  shoulder_below_neck: 0.02, // fraction of height
  neck_above_shoulder: 0.004, // the rig's neck_01 sits at shoulder height, at the base of the neck
  pelvis_below_hip: 0.009,
  spine: [0.187, 0.417, 0.682], // fractions of pelvis -> neck
  // Mesh2Motion skins each vertex to the bone whose midpoint (bone -> first child)
  // is closest, so the neck/head weight boundary ends up at
  // (neck + 2 * head + head_top) / 4. The head bone goes in the middle of the
  // narrow part of the neck and head_top about a third up the head, which puts
  // that boundary under the chin: the whole face (jaw, beard) follows the head
  head_along_neck: 0.5, // fraction of (bottom -> top of the narrow part of the neck)
  head_top_above_head: 0.36, // fraction of (head bone -> top of head)
  ball_along_foot: 0.65,
  clavicle_along_shoulder: 0.12
}

type Side = 'l' | 'r'
const SIDES: Array<[Side, number]> = [['l', 1], ['r', -1]]

interface ArmAnalysis {
  found: boolean
  shoulder: Vector3
  elbow: Vector3
  wrist: Vector3
  fingertip: Vector3
  elbow_method: JointMethod
  wrist_method: JointMethod
  angle_degrees: number
}

/*
 * HumanJointEstimator
 * Geometric, deterministic estimation of humanoid joints from surface samples.
 *
 * Overview:
 * 1. body frame: floor, height, centre line and facing (BodyFrameEstimator)
 * 2. horizontal slices clustered along X (BodySliceProfile)
 * 3. crotch = first slice from the bottom where the legs join into one cluster
 * 4. neck = narrowest slice between torso and the top of the head
 * 5. arms traced from the shoulder towards the furthest point (the finger tips),
 *    with slices along the arm. The wrist is where the arm stops narrowing and the
 *    flat hand starts, the elbow is where the centre line bends (or proportional)
 * 6. legs follow the leg clusters; the ankle is where the foot starts to stick out forward
 * 7. FitConstraintSolver: symmetry, anatomical order, distance to the surface,
 *    final confidence and status
 *
 * Body proportions are only used to interpolate between measured landmarks or as
 * a fallback, and in that case the joint is marked with lower confidence.
 */
export class HumanJointEstimator implements JointEstimator {
  public async estimate (input: GeometrySnapshot, options: AutoFitOptions = DEFAULT_AUTO_FIT_OPTIONS, signal?: AbortSignal): Promise<AutoFitResult> {
    const start_time = performance.now()
    HumanJointEstimator.throw_if_aborted(signal)

    const frame_result = BodyFrameEstimator.estimate(input, options)
    const diagnostics: Record<string, number | string | boolean> = {
      sample_count: input.point_count,
      source_triangle_count: input.source_triangle_count,
      source_mesh_count: input.source_mesh_count
    }

    if (frame_result.frame === null) {
      return {
        status: 'unsupported',
        pose: 'unknown',
        joints: [],
        warnings: [frame_result.unsupported_reason ?? 'The model could not be analyzed.', ...frame_result.warnings],
        diagnostics
      }
    }

    await HumanJointEstimator.yield_to_browser()
    HumanJointEstimator.throw_if_aborted(signal)

    const analysis = new HumanBodyAnalysis(input, frame_result.frame)
    const raw = analysis.run()

    await HumanJointEstimator.yield_to_browser()
    HumanJointEstimator.throw_if_aborted(signal)

    const warnings = [...frame_result.warnings, ...analysis.warnings]
    const pose = HumanJointEstimator.resolve_pose(analysis.detected_pose, options, warnings)

    const solved = FitConstraintSolver.solve(raw, {
      snapshot: input,
      frame: frame_result.frame,
      options,
      required_parts_found: analysis.parts_found
    })

    Object.assign(diagnostics, analysis.diagnostics, solved.diagnostics, {
      facing: frame_result.frame.facing,
      height: frame_result.frame.height,
      elapsed_ms: Math.round(performance.now() - start_time)
    })

    return {
      status: solved.status,
      pose,
      joints: solved.joints,
      warnings: [...warnings, ...solved.warnings],
      diagnostics
    }
  }

  private static resolve_pose (detected: DetectedPose, options: AutoFitOptions, warnings: string[]): DetectedPose {
    if (options.pose_mode === 'auto') {
      return detected
    }
    if (detected !== 'unknown' && detected !== options.pose_mode) {
      warnings.push(`The arms look like an ${detected === 'a-pose' ? 'A-pose' : 'T-pose'}, but ${options.pose_mode === 'a-pose' ? 'A-pose' : 'T-pose'} was selected. Review the arm joints.`)
    }
    return options.pose_mode
  }

  private static throw_if_aborted (signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      throw new AutoFitAbortedError()
    }
  }

  // let the browser paint the progress state between the heavier stages
  private static async yield_to_browser (): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * Holds the intermediate measurements of one run so the stages can share them.
 */
class HumanBodyAnalysis {
  public readonly warnings: string[] = []
  public readonly diagnostics: Record<string, number | string | boolean> = {}
  public detected_pose: DetectedPose = 'unknown'
  public readonly parts_found = { head: false, arm_l: false, arm_r: false, leg_l: false, leg_r: false }

  private readonly profile: BodySliceProfile
  private readonly joints: Partial<Record<HumanJointId, JointEstimate>> = {}
  private readonly h: number
  private readonly cx: number
  private readonly core_half_width: number

  constructor (private readonly snapshot: GeometrySnapshot, private readonly frame: BodyFrame) {
    this.profile = new BodySliceProfile(snapshot, frame)
    this.h = frame.height
    this.cx = frame.center_x
    this.core_half_width = this.h * 0.06
  }

  public run (): Partial<Record<HumanJointId, JointEstimate>> {
    const crotch_y = this.find_crotch()
    const { neck_low, neck_high, neck_half_width } = this.find_neck(crotch_y)
    const chest_half_width = this.find_chest_half_width(neck_low, neck_half_width)
    this.detect_head(neck_high, neck_half_width, chest_half_width)
    this.place_head(neck_low, neck_high)

    const arms = SIDES.map(([side, sign]) => this.analyze_arm(side, sign, neck_low, neck_high, chest_half_width))
    this.classify_pose(arms)

    const found_shoulders = arms.filter(arm => arm.found).map(arm => arm.shoulder.y)
    const shoulder_y = found_shoulders.length > 0
      ? PointCloudUtils.mean(found_shoulders)
      : neck_low - PROPORTIONS.shoulder_below_neck * this.h
    this.place_neck(shoulder_y, neck_low)

    const hip_y = crotch_y + PROPORTIONS.hip_above_crotch * (shoulder_y - crotch_y)
    SIDES.forEach(([side, sign]) => { this.analyze_leg(side, sign, crotch_y, hip_y) })
    this.place_spine(hip_y)

    this.diagnostics.crotch_height_ratio = this.round((crotch_y - this.frame.floor_y) / this.h)
    this.diagnostics.neck_height_ratio = this.round((neck_low - this.frame.floor_y) / this.h)
    this.diagnostics.chest_half_width_ratio = this.round(chest_half_width / this.h)

    return this.joints
  }

  // -- torso and head ------------------------------------------------------

  /**
   * Going up from the shins, the first height where a cluster crosses the centre
   * line for a few consecutive slices is where the legs join the body.
   */
  private find_crotch (): number {
    const floor = this.frame.floor_y
    const candidates = this.profile.slices_between(floor + 0.15 * this.h, floor + 0.75 * this.h)

    for (let k = 0; k + 2 < candidates.length; k++) {
      const joined = [0, 1, 2].every(offset => this.profile.central_cluster(candidates[k + offset]) !== null)
      if (joined) {
        const crotch_y = candidates[k].y_min
        if (crotch_y - floor < 0.2 * this.h) {
          break // legs joined almost at the floor: long clothing or legs touching
        }
        return crotch_y
      }
    }

    this.warnings.push('Could not separate the legs (long clothing or legs touching?). Leg joints are approximate.')
    return floor + 0.47 * this.h
  }

  /**
   * The neck is the narrowest part between the torso and the top of the head.
   * The top few percent are skipped since the crown of the head is narrow too.
   */
  private find_neck (crotch_y: number): { neck_low: number, neck_high: number, neck_half_width: number } {
    const top = this.frame.top_y
    const slices = this.profile.slices_between(crotch_y + 0.25 * (top - crotch_y), top - 0.05 * this.h)
    const widths = slices.map(slice => this.profile.central_half_width(slice))
    const smoothed = widths.map((_, k) => PointCloudUtils.median(widths.slice(Math.max(0, k - 1), k + 2)))

    let min_index = -1
    smoothed.forEach((width, k) => {
      if (width > 0 && (min_index === -1 || width < smoothed[min_index])) {
        min_index = k
      }
    })

    if (min_index === -1) {
      this.warnings.push('Could not find the neck. Head and neck joints are approximate.')
      const neck_y = this.frame.floor_y + 0.83 * this.h
      return { neck_low: neck_y, neck_high: neck_y + 0.04 * this.h, neck_half_width: 0.04 * this.h }
    }

    // grow the narrow run in both directions while the width stays close to the minimum
    const limit = smoothed[min_index] * 1.15
    let low = min_index
    let high = min_index
    while (low > 0 && smoothed[low - 1] > 0 && smoothed[low - 1] <= limit) { low-- }
    while (high < smoothed.length - 1 && smoothed[high + 1] > 0 && smoothed[high + 1] <= limit) { high++ }

    return { neck_low: slices[low].y_min, neck_high: slices[high].y_max, neck_half_width: smoothed[min_index] }
  }

  /**
   * A neck has to be clearly narrower than the chest, and the head above it
   * wider than the neck and roughly as tall as it is wide. A headless torso
   * fails one of these. Stylized characters can have thick necks and narrow
   * heads, so the head/neck ratio is kept loose.
   */
  private detect_head (neck_high: number, neck_half_width: number, chest_half_width: number): void {
    const top = this.frame.top_y
    const head_widths = this.profile.slices_between(neck_high, top).map(slice => this.profile.central_half_width(slice))
    const head_half_width = head_widths.length > 0 ? Math.max(...head_widths) : 0
    const head_height = top - neck_high
    const head_aspect = head_half_width > 0 ? head_height / (2 * head_half_width) : 0

    this.parts_found.head =
      neck_half_width < chest_half_width * 0.65 &&
      head_half_width > neck_half_width * 1.2 &&
      head_height > 0.06 * this.h &&
      head_aspect > 0.5 && head_aspect < 2.5

    if (!this.parts_found.head) {
      this.warnings.push('No head was detected above the neck.')
      return
    }

    // A big head right above the shoulders (chibi) is closer to the shoulder
    // and arm bones than to the head bone in places, so the skinning gives
    // part of it to the arms. Mesh2Motion already has a fix for that: suggest
    // it, with the plane at the bottom of the head
    if (head_half_width > chest_half_width * 0.9 || head_height > 0.25 * this.h) {
      const plane_height = Math.round(neck_high * 100) / 100
      this.diagnostics.suggested_head_correction_height = plane_height
      this.warnings.push(`Large head (chibi proportions): if the arms pull on the head when animating, enable "Use Head Weight Correction" with a height of about ${plane_height.toFixed(2)}.`)
    }
  }

  /**
   * neck_01 starts at the base of the neck, level with the shoulders, like in
   * the rig template. It is never placed above the narrow part of the neck.
   */
  private place_neck (shoulder_y: number, neck_low: number): void {
    const neck_y = Math.min(shoulder_y + PROPORTIONS.neck_above_shoulder * this.h, neck_low)
    this.set_joint('neck', new Vector3(this.cx, neck_y, this.core_z_at(neck_y)), this.parts_found.head ? 'measured' : 'fallback')
  }

  private place_head (neck_low: number, neck_high: number): void {
    const top = this.frame.top_y
    const head_method: JointMethod = this.parts_found.head ? 'measured' : 'fallback'

    const head_y = PointCloudUtils.lerp(neck_low, neck_high, PROPORTIONS.head_along_neck)
    const head_z = this.core_z_at(head_y)
    this.set_joint('head', new Vector3(this.cx, head_y, head_z), head_method)

    const head_top_y = head_y + PROPORTIONS.head_top_above_head * (top - head_y)
    this.set_joint('head_top', new Vector3(this.cx, head_top_y, head_z), this.parts_found.head ? 'proportional' : 'fallback')
  }

  /**
   * Torso half width just below the armpits. Using the narrowest slice of the
   * band ignores slices where an arm happens to touch the torso.
   */
  private find_chest_half_width (neck_low: number, neck_half_width: number): number {
    const band = this.profile.slices_between(neck_low - 0.16 * this.h, neck_low - 0.08 * this.h)
    const widths = band.map(slice => this.profile.central_half_width(slice)).filter(width => width > neck_half_width)
    const fallback = 0.11 * this.h

    if (widths.length === 0) {
      this.warnings.push('Could not measure the chest width. Shoulder positions are approximate.')
      return fallback
    }

    const chest_half_width = Math.min(...widths)
    if (chest_half_width > 0.2 * this.h) {
      this.warnings.push('The arms seem to touch the torso. Shoulder positions are approximate.')
      return fallback
    }
    return chest_half_width
  }

  private place_spine (hip_y: number): void {
    const pelvis_y = hip_y - PROPORTIONS.pelvis_below_hip * this.h
    this.set_joint('pelvis', new Vector3(this.cx, pelvis_y, this.core_z_at(pelvis_y)), 'measured')

    const neck = this.joints.neck
    const neck_y = neck !== undefined ? neck.world_position[1] : this.frame.floor_y + 0.83 * this.h
    const ids: HumanJointId[] = ['spine_lower', 'spine_middle', 'spine_upper']
    ids.forEach((id, k) => {
      const y = PointCloudUtils.lerp(pelvis_y, neck_y, PROPORTIONS.spine[k])
      this.set_joint(id, new Vector3(this.cx, y, this.core_z_at(y)), 'proportional')
    })
  }

  // -- arms ----------------------------------------------------------------

  private analyze_arm (side: Side, sign: number, neck_low: number, neck_high: number, chest_half_width: number): ArmAnalysis {
    const points = this.snapshot.points
    const floor = this.frame.floor_y
    const shoulder_guess = new Vector3(
      this.cx + sign * chest_half_width * 1.05,
      neck_low - PROPORTIONS.shoulder_below_neck * this.h,
      this.core_z_at(neck_low)
    )

    // the finger tips are the furthest points from the shoulder on this side.
    // Arms in A/T pose stay below the head, which matters for big (chibi) heads
    const candidate_indices: number[] = []
    for (let i = 0; i < this.snapshot.point_count; i++) {
      const lateral = (points[i * 3] - this.cx) * sign
      const y = points[i * 3 + 1]
      if (lateral > chest_half_width * 1.3 && y > floor + 0.3 * this.h && y < neck_high) {
        candidate_indices.push(i)
      }
    }

    const point = new Vector3()
    const distances = candidate_indices.map(i => point.fromArray(points, i * 3).distanceTo(shoulder_guess))
    const far_distance = PointCloudUtils.percentile(distances, 0.995)
    const tip = new Vector3()
    let tip_count = 0
    candidate_indices.forEach((i, k) => {
      if (distances[k] >= far_distance) {
        tip.add(point.fromArray(points, i * 3))
        tip_count++
      }
    })
    if (tip_count > 0) { tip.divideScalar(tip_count) }

    const arm_length = tip.distanceTo(shoulder_guess)
    if (candidate_indices.length < 30 || tip_count === 0 || arm_length < 0.15 * this.h) {
      return this.fallback_arm(side, sign, shoulder_guess)
    }

    const axis = tip.clone().sub(shoulder_guess).normalize()
    const sections = this.arm_sections(shoulder_guess, axis, arm_length, sign, chest_half_width, neck_high)
    const valid_sections = sections.filter(section => section !== null)
    if (valid_sections.length < sections.length * 0.5) {
      this.warnings.push(`Could not follow the ${side === 'l' ? 'left' : 'right'} arm. Arm joints are approximate.`)
      return this.fallback_arm(side, sign, shoulder_guess)
    }

    // shoulder: where the upper arm centre line meets the torso side
    const upper_sections = valid_sections.filter(section => section.s > 0.15 && section.s < 0.45)
    let shoulder = shoulder_guess.clone()
    if (upper_sections.length >= 2) {
      const line_start = upper_sections[0].center
      const line_direction = upper_sections[upper_sections.length - 1].center.clone().sub(line_start).normalize()
      if (Math.abs(line_direction.x) > 0.2) {
        // follow the upper arm line back to the side of the torso. This stays
        // correct when the arm is rotated down (A-pose)
        const t = (shoulder_guess.x - line_start.x) / line_direction.x
        shoulder = line_start.clone().addScaledVector(line_direction, t)
      } else {
        // arm almost vertical: closest point of the line to the guess
        const t = shoulder_guess.clone().sub(line_start).dot(line_direction)
        shoulder = line_start.clone().addScaledVector(line_direction, t)
      }
      // the shoulder can't be above the base of the neck or inside the chest
      shoulder.y = Math.min(shoulder.y, neck_low)
      if ((shoulder.x - this.cx) * sign < chest_half_width * 0.8) {
        shoulder.x = this.cx + sign * chest_half_width * 0.8
      }
    }

    // arm parameter s is measured from shoulder_guess, convert positions from the refined shoulder
    const shoulder_s = shoulder.clone().sub(shoulder_guess).dot(axis) / arm_length
    const s_from_shoulder = (fraction: number): number => shoulder_s + fraction * (1 - shoulder_s)
    const center_at = (s: number): Vector3 => HumanBodyAnalysis.interpolate_sections(valid_sections, s)

    const [wrist_s, wrist_method] = this.find_wrist(valid_sections, s_from_shoulder)
    const wrist = center_at(wrist_s)

    // elbow: where the centre line clearly bends, else proportional along the
    // (possibly bent) centre line
    let elbow_s = PointCloudUtils.lerp(shoulder_s, wrist_s, PROPORTIONS.elbow_between_shoulder_and_wrist)
    let elbow_method: JointMethod = 'proportional'
    const shoulder_to_wrist = wrist.clone().sub(shoulder)
    const segment_length = shoulder_to_wrist.length()
    if (segment_length > 1e-6) {
      shoulder_to_wrist.divideScalar(segment_length)
      let best_deviation = 0.035 * this.h
      valid_sections.forEach((section) => {
        const fraction = (section.s - shoulder_s) / Math.max(wrist_s - shoulder_s, 1e-6)
        if (fraction < 0.4 || fraction > 0.65) { return }
        const offset = section.center.clone().sub(shoulder)
        const deviation = offset.sub(shoulder_to_wrist.clone().multiplyScalar(offset.dot(shoulder_to_wrist))).length()
        if (deviation > best_deviation) {
          best_deviation = deviation
          elbow_s = section.s
          elbow_method = 'measured'
        }
      })
    }
    const elbow = center_at(elbow_s)

    const angle_degrees = Math.atan2(shoulder.y - wrist.y, Math.abs(wrist.x - shoulder.x)) * 180 / Math.PI
    this.diagnostics[`arm_angle_${side}`] = Math.round(angle_degrees)
    this.parts_found[`arm_${side}`] = true

    // the furthest points of the arm are the tips of the longest (middle) finger
    const arm: ArmAnalysis = { found: true, shoulder, elbow, wrist, fingertip: tip, elbow_method, wrist_method, angle_degrees }
    this.place_arm(side, sign, arm)
    return arm
  }

  /**
   * The wrist is the narrowest part of the arm between the forearm and the
   * (wider) hand. Placing it where the hand starts to look flat is too far out:
   * that is the middle of the palm, and the palm then gets weighted to the
   * forearm and twists. Flatness is only a fallback for arms without a clear
   * narrowing, then plain proportions.
   */
  private find_wrist (sections: ArmSection[], s_from_shoulder: (fraction: number) => number): [number, JointMethod] {
    const spread = sections.map((_, k) => PointCloudUtils.mean(sections.slice(Math.max(0, k - 1), k + 2).map(section => section.major_spread)))
    const in_range = (k: number, low: number, high: number): boolean => sections[k].s >= s_from_shoulder(low) && sections[k].s <= s_from_shoulder(high)

    let narrowest = -1
    sections.forEach((_, k) => {
      if (in_range(k, 0.55, 0.9) && (narrowest === -1 || spread[k] < spread[narrowest])) {
        narrowest = k
      }
    })

    if (narrowest !== -1) {
      const forearm_peak = Math.max(0, ...sections.map((_, k) => (in_range(k, 0.35, 1) && k < narrowest) ? spread[k] : 0))
      const hand_peak = Math.max(0, ...sections.map((_, k) => k > narrowest ? spread[k] : 0))
      if (spread[narrowest] < forearm_peak * 0.85 && spread[narrowest] < hand_peak * 0.8) {
        // the smoothing pulls the minimum towards the forearm when the hand starts
        // abruptly, so settle on the narrowest raw section next to it
        let best = narrowest
        ;[narrowest - 1, narrowest + 1].forEach((k) => {
          if (k >= 0 && k < sections.length && sections[k].major_spread < sections[best].major_spread) {
            best = k
          }
        })
        return [sections[best].s, 'measured']
      }
    }

    const search = sections.filter(section => section.s >= s_from_shoulder(0.58) && section.s <= s_from_shoulder(0.86))
    for (let k = 0; k + 1 < search.length; k++) {
      if (search[k].flatness > 1.6 && search[k + 1].flatness > 1.6) {
        return [search[k].s - (search[k].s_step / 2), 'measured']
      }
    }

    return [s_from_shoulder(PROPORTIONS.wrist_along_arm), 'proportional']
  }

  /**
   * Slices perpendicular to the arm axis. Returns the centre of each slice and
   * how flat its cross section is (ratio of the two spreads).
   */
  private arm_sections (origin: Vector3, axis: Vector3, length: number, sign: number, chest_half_width: number, neck_high: number): Array<ArmSection | null> {
    const section_count = 30
    const max_radius = Math.min(0.07 * this.h, 0.25 * length)
    const points = this.snapshot.points
    const members: number[][] = Array.from({ length: section_count }, () => [])
    const offset = new Vector3()

    for (let i = 0; i < this.snapshot.point_count; i++) {
      if (points[i * 3 + 1] > neck_high) { continue } // head
      offset.fromArray(points, i * 3).sub(origin)
      const s = offset.dot(axis) / length
      if (s < 0.05 || s >= 1) { continue }
      const radial = offset.addScaledVector(axis, -s * length).length()
      if (radial > max_radius) { continue }
      // close to the torso, ignore points of the chest itself
      if (s < 0.5 && (points[i * 3] - this.cx) * sign < chest_half_width * 1.1) { continue }
      members[Math.floor(s * section_count)].push(i)
    }

    // two directions perpendicular to the arm for the flatness measure
    const helper = Math.abs(axis.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)
    const perpendicular_a = new Vector3().crossVectors(axis, helper).normalize()
    const perpendicular_b = new Vector3().crossVectors(axis, perpendicular_a).normalize()
    const s_step = 1 / section_count

    return members.map((indices, k): ArmSection | null => {
      if (indices.length < 6) { return null }
      const center = new Vector3()
      indices.forEach(i => center.add(offset.fromArray(points, i * 3)))
      center.divideScalar(indices.length)

      // 2x2 covariance in the perpendicular plane
      let saa = 0
      let sbb = 0
      let sab = 0
      indices.forEach((i) => {
        offset.fromArray(points, i * 3).sub(center)
        const a = offset.dot(perpendicular_a)
        const b = offset.dot(perpendicular_b)
        saa += a * a
        sbb += b * b
        sab += a * b
      })
      saa /= indices.length
      sbb /= indices.length
      sab /= indices.length
      const trace = saa + sbb
      const det = saa * sbb - sab * sab
      const discriminant = Math.sqrt(Math.max(trace * trace / 4 - det, 0))
      const major = trace / 2 + discriminant
      const minor = Math.max(trace / 2 - discriminant, 1e-12)

      return { s: (k + 0.5) * s_step, s_step, center, flatness: Math.sqrt(major / minor), major_spread: Math.sqrt(major), minor_spread: Math.sqrt(minor), count: indices.length }
    })
  }

  private static interpolate_sections (sections: ArmSection[], s: number): Vector3 {
    if (s <= sections[0].s) {
      return sections[0].center.clone()
    }
    for (let k = 0; k + 1 < sections.length; k++) {
      const a = sections[k]
      const b = sections[k + 1]
      if (s >= a.s && s <= b.s) {
        const t = (s - a.s) / Math.max(b.s - a.s, 1e-9)
        return a.center.clone().lerp(b.center, t)
      }
    }
    return sections[sections.length - 1].center.clone()
  }

  private fallback_arm (side: Side, sign: number, shoulder: Vector3): ArmAnalysis {
    this.warnings.push(`The ${side === 'l' ? 'left' : 'right'} arm was not found. Place its joints manually.`)
    const elbow = shoulder.clone().add(new Vector3(sign * 0.17 * this.h, 0, 0))
    const wrist = elbow.clone().add(new Vector3(sign * 0.15 * this.h, 0, 0))
    const fingertip = wrist.clone().add(new Vector3(sign * 0.1 * this.h, 0, 0))
    const arm: ArmAnalysis = { found: false, shoulder, elbow, wrist, fingertip, elbow_method: 'fallback', wrist_method: 'fallback', angle_degrees: NaN }
    this.place_arm(side, sign, arm)
    return arm
  }

  private place_arm (side: Side, sign: number, arm: ArmAnalysis): void {
    const shoulder_method: JointMethod = arm.found ? 'measured' : 'fallback'
    this.set_joint(`shoulder_${side}`, arm.shoulder, shoulder_method)
    this.set_joint(`elbow_${side}`, arm.elbow, arm.elbow_method)
    this.set_joint(`wrist_${side}`, arm.wrist, arm.wrist_method)
    this.set_joint(`fingertip_${side}`, arm.fingertip, shoulder_method)

    // clavicle starts near the middle of the chest, slightly in front of the spine
    const clavicle_y = arm.shoulder.y - 0.012 * this.h
    const slice = this.profile.slice_at(clavicle_y)
    const core_z = this.core_z_at(clavicle_y)
    const front_values: number[] = []
    slice.point_indices.forEach((i) => {
      if (Math.abs(this.snapshot.points[i * 3] - this.cx) < this.core_half_width) {
        front_values.push(this.snapshot.points[i * 3 + 2])
      }
    })
    const front_z = front_values.length > 0 ? PointCloudUtils.percentile(front_values, 0.9) : core_z
    const clavicle = new Vector3(
      this.cx + sign * Math.abs(arm.shoulder.x - this.cx) * PROPORTIONS.clavicle_along_shoulder,
      clavicle_y,
      core_z + 0.6 * (front_z - core_z)
    )
    this.set_joint(`clavicle_${side}`, clavicle, arm.found ? 'proportional' : 'fallback')
  }

  private classify_pose (arms: ArmAnalysis[]): void {
    const angles = arms.filter(arm => arm.found).map(arm => arm.angle_degrees)
    if (angles.length === 0) {
      this.detected_pose = 'unknown'
      return
    }
    const angle = PointCloudUtils.mean(angles)
    if (angle <= 25) {
      this.detected_pose = 't-pose'
    } else if (angle <= 65) {
      this.detected_pose = 'a-pose'
    } else {
      this.detected_pose = 'unknown'
      this.warnings.push('The arms point mostly downwards. Auto Fit works best with A-pose or T-pose models, review the arm joints.')
    }
  }

  // -- legs ----------------------------------------------------------------

  private analyze_leg (side: Side, sign: number, crotch_y: number, hip_y: number): void {
    const floor = this.frame.floor_y
    const max_offset = 0.25 * this.h
    const leg_slices = this.profile.slices_between(floor + 0.12 * this.h, crotch_y - 0.02 * this.h)
    const cluster_for = (slice: HorizontalSlice): ReturnType<BodySliceProfile['inner_side_cluster']> =>
      this.profile.inner_side_cluster(slice, sign, max_offset)

    const found_count = leg_slices.filter(slice => cluster_for(slice) !== null).length
    const leg_found = leg_slices.length > 0 && found_count >= leg_slices.length * 0.6

    if (!leg_found) {
      this.warnings.push(`The ${side === 'l' ? 'left' : 'right'} leg was not found. Place its joints manually.`)
      const x = this.cx + sign * 0.06 * this.h
      const ankle_y = floor + 0.05 * this.h
      this.set_joint(`hip_${side}`, new Vector3(x, hip_y, this.frame.center_z), 'fallback')
      this.set_joint(`knee_${side}`, new Vector3(x, PointCloudUtils.lerp(ankle_y, hip_y, 0.5), this.frame.center_z), 'fallback')
      this.set_joint(`ankle_${side}`, new Vector3(x, ankle_y, this.frame.center_z), 'fallback')
      this.set_joint(`ball_${side}`, new Vector3(x, floor + 0.015 * this.h, this.frame.center_z + 0.08 * this.h), 'fallback')
      this.set_joint(`toe_${side}`, new Vector3(x, floor + 0.01 * this.h, this.frame.center_z + 0.12 * this.h), 'fallback')
      return
    }
    this.parts_found[`leg_${side}`] = true

    const average_center = (slices: HorizontalSlice[]): { x: number, z: number } | null => {
      const xs: number[] = []
      const zs: number[] = []
      slices.forEach((slice) => {
        const cluster = cluster_for(slice)
        if (cluster !== null) {
          xs.push(cluster.mean_x)
          zs.push(cluster.mean_z)
        }
      })
      return xs.length > 0 ? { x: PointCloudUtils.mean(xs), z: PointCloudUtils.mean(zs) } : null
    }

    // hip: centre of the thigh just under the crotch
    const thigh_center = average_center(this.profile.slices_between(crotch_y - 0.1 * this.h, crotch_y - 0.02 * this.h)) ??
      { x: this.cx + sign * 0.06 * this.h, z: this.frame.center_z }
    this.set_joint(`hip_${side}`, new Vector3(thigh_center.x, hip_y, thigh_center.z), 'measured')

    // ankle: going down the shin, the slice where the foot starts sticking out forward
    const shin_slices = this.profile.slices_between(floor + 0.1 * this.h, floor + 0.2 * this.h)
    const shin_extents = shin_slices.map(cluster_for).filter(cluster => cluster !== null).map(cluster => cluster.max_z - cluster.min_z)
    const shin_extent = shin_extents.length > 0 ? PointCloudUtils.median(shin_extents) : 0.07 * this.h

    let ankle_y = floor + 0.05 * this.h
    let ankle_method: JointMethod = 'fallback'
    const lower_slices = this.profile.slices_between(floor + 0.015 * this.h, floor + 0.12 * this.h).reverse()
    for (const slice of lower_slices) {
      const cluster = cluster_for(slice)
      if (cluster !== null && (cluster.max_z - cluster.min_z) > shin_extent * 1.5) {
        ankle_y = PointCloudUtils.clamp(slice.y_max, floor + 0.02 * this.h, floor + 0.12 * this.h)
        ankle_method = 'measured'
        break
      }
    }
    if (ankle_method === 'fallback') {
      this.warnings.push(`Could not find where the ${side === 'l' ? 'left' : 'right'} foot starts. The ankle is approximate.`)
    }

    const ankle_center = average_center(this.profile.slices_between(ankle_y + 0.005 * this.h, ankle_y + 0.04 * this.h)) ?? thigh_center
    const ankle = new Vector3(ankle_center.x, ankle_y, ankle_center.z)
    this.set_joint(`ankle_${side}`, ankle, ankle_method)

    // knee: halfway up the leg, on the centre of the leg at that height
    const knee_y = PointCloudUtils.lerp(ankle_y, hip_y, PROPORTIONS.knee_between_ankle_and_hip)
    const knee_center = average_center(this.profile.slices_between(knee_y - 0.01 * this.h, knee_y + 0.01 * this.h)) ??
      { x: PointCloudUtils.lerp(ankle.x, thigh_center.x, 0.5), z: PointCloudUtils.lerp(ankle.z, thigh_center.z, 0.5) }
    this.set_joint(`knee_${side}`, new Vector3(knee_center.x, knee_y, knee_center.z), 'proportional')

    this.place_foot(side, sign, ankle)
  }

  private place_foot (side: Side, sign: number, ankle: Vector3): void {
    const points = this.snapshot.points
    const floor = this.frame.floor_y
    const foot_indices: number[] = []
    for (let i = 0; i < this.snapshot.point_count; i++) {
      const x = points[i * 3]
      if (points[i * 3 + 1] < ankle.y && (x - this.cx) * sign > 0 && Math.abs(x - ankle.x) < 0.1 * this.h) {
        foot_indices.push(i)
      }
    }

    const foot_height = ankle.y - floor
    if (foot_indices.length < 20) {
      this.set_joint(`ball_${side}`, new Vector3(ankle.x, floor + 0.25 * foot_height, ankle.z + 0.08 * this.h), 'fallback')
      this.set_joint(`toe_${side}`, new Vector3(ankle.x, floor + 0.15 * foot_height, ankle.z + 0.12 * this.h), 'fallback')
      return
    }

    const toe_z = PointCloudUtils.percentile(foot_indices.map(i => points[i * 3 + 2]), 0.97)
    const toe_xs = foot_indices.filter(i => points[i * 3 + 2] > toe_z - 0.02 * this.h).map(i => points[i * 3])
    const toe_x = toe_xs.length > 0 ? PointCloudUtils.mean(toe_xs) : ankle.x

    const toe = new Vector3(toe_x, floor + 0.15 * foot_height, toe_z)
    const ball = new Vector3(
      PointCloudUtils.lerp(ankle.x, toe_x, PROPORTIONS.ball_along_foot),
      floor + 0.25 * foot_height,
      PointCloudUtils.lerp(ankle.z, toe_z, PROPORTIONS.ball_along_foot)
    )
    this.set_joint(`toe_${side}`, toe, 'measured')
    this.set_joint(`ball_${side}`, ball, 'proportional')
  }

  // -- helpers -------------------------------------------------------------

  private core_z_at (y: number): number {
    return this.profile.core_z(this.profile.slice_at(y), this.core_half_width) ?? this.frame.center_z
  }

  private set_joint (id: HumanJointId, position: Vector3, method: JointMethod): void {
    this.joints[id] = {
      id,
      world_position: [position.x, position.y, position.z],
      confidence: BASE_CONFIDENCE[method],
      method,
      warnings: []
    }
  }

  private round (value: number): number {
    return Math.round(value * 1000) / 1000
  }
}

interface ArmSection {
  s: number
  s_step: number
  center: Vector3
  flatness: number
  major_spread: number // standard deviation along the widest direction of the cross section
  minor_spread: number
  count: number
}
