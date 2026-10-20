/*
 * Shared types for the Auto Fit Skeleton feature.
 *
 * Coordinate convention (same as the human rig template and the rest of the editor):
 *   +Y is up, the character faces +Z, and the character's LEFT side is +X.
 *
 * Everything in here is plain data so estimators stay decoupled from the editor
 * (and could later run inside a Web Worker or be swapped for another provider,
 * e.g. an image based pose landmarker or the joints of an externally rigged model).
 */

export type Vec3Tuple = [number, number, number]

export type PoseMode = 'auto' | 'a-pose' | 't-pose'
export type FacingMode = 'auto' | 'front' | 'back'
export type DetectedPose = 'a-pose' | 't-pose' | 'unknown'
export type AutoFitStatus = 'success' | 'partial' | 'unsupported'

/**
 * Semantic joints the estimator knows about. These are NOT bone names, the
 * applicator maps them onto whatever bones the loaded rig actually has.
 * Individual fingers are not estimated: the finger tip (end of the longest
 * finger) is only used to orient and size the rig's hand as a whole.
 */
export type HumanJointId =
  'pelvis' | 'spine_lower' | 'spine_middle' | 'spine_upper' | 'neck' | 'head' | 'head_top' |
  'clavicle_l' | 'shoulder_l' | 'elbow_l' | 'wrist_l' | 'fingertip_l' |
  'clavicle_r' | 'shoulder_r' | 'elbow_r' | 'wrist_r' | 'fingertip_r' |
  'hip_l' | 'knee_l' | 'ankle_l' | 'ball_l' | 'toe_l' |
  'hip_r' | 'knee_r' | 'ankle_r' | 'ball_r' | 'toe_r'

export const HUMAN_JOINT_IDS: readonly HumanJointId[] = [
  'pelvis', 'spine_lower', 'spine_middle', 'spine_upper', 'neck', 'head', 'head_top',
  'clavicle_l', 'shoulder_l', 'elbow_l', 'wrist_l', 'fingertip_l',
  'clavicle_r', 'shoulder_r', 'elbow_r', 'wrist_r', 'fingertip_r',
  'hip_l', 'knee_l', 'ankle_l', 'ball_l', 'toe_l',
  'hip_r', 'knee_r', 'ankle_r', 'ball_r', 'toe_r'
]

/**
 * Joints that matter most for deformation. If any of these could not be
 * measured, the result is reported as partial instead of success.
 */
export const CRITICAL_JOINT_IDS: readonly HumanJointId[] = [
  'pelvis', 'neck', 'head',
  'shoulder_l', 'elbow_l', 'wrist_l', 'shoulder_r', 'elbow_r', 'wrist_r',
  'hip_l', 'knee_l', 'ankle_l', 'hip_r', 'knee_r', 'ankle_r'
]

/**
 * How a joint position was obtained:
 * - measured: derived from the geometry (slice centroids, narrowing, extremities)
 * - proportional: interpolated between measured joints using body proportions
 * - mirrored: copied from the opposite side because this side could not be measured
 * - fallback: body proportions only, there was not enough geometry evidence
 */
export type JointMethod = 'measured' | 'proportional' | 'mirrored' | 'fallback'

export type ConfidenceLevel = 'high' | 'medium' | 'low'

// below LOW_CONFIDENCE_THRESHOLD a joint is reported as inaccurate in the UI
export const HIGH_CONFIDENCE_THRESHOLD: number = 0.75
export const LOW_CONFIDENCE_THRESHOLD: number = 0.45

export function confidence_level (confidence: number): ConfidenceLevel {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) { return 'high' }
  if (confidence >= LOW_CONFIDENCE_THRESHOLD) { return 'medium' }
  return 'low'
}

export interface JointEstimate {
  id: HumanJointId
  world_position: Vec3Tuple
  confidence: number // 0..1
  method: JointMethod
  warnings: string[]
}

export interface AutoFitResult {
  status: AutoFitStatus
  pose: DetectedPose
  joints: JointEstimate[]
  warnings: string[]
  diagnostics: Record<string, number | string | boolean>
}

export interface AutoFitOptions {
  pose_mode: PoseMode
  facing: FacingMode
  use_symmetry: boolean
}

export const DEFAULT_AUTO_FIT_OPTIONS: AutoFitOptions = {
  pose_mode: 'auto',
  facing: 'auto',
  use_symmetry: true
}

/**
 * Serializable, read-only view of the model geometry used for the analysis.
 * Points are surface samples in world space (xyz triples).
 */
export interface GeometrySnapshot {
  points: Float32Array
  point_count: number
  bounds_min: Vec3Tuple
  bounds_max: Vec3Tuple
  source_mesh_count: number
  source_triangle_count: number
}

/**
 * Anything that can propose joint positions for a humanoid. The geometric
 * estimator is the first implementation; others can be added without touching the UI.
 */
export interface JointEstimator {
  estimate: (input: GeometrySnapshot, options: AutoFitOptions, signal?: AbortSignal) => Promise<AutoFitResult>
}

export class AutoFitAbortedError extends Error {
  constructor () {
    super('Auto fit was cancelled')
    this.name = 'AutoFitAbortedError'
  }
}
