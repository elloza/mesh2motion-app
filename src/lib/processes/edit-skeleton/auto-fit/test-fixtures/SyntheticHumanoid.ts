import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type Matrix4,
  type Object3D
} from 'three'
import { type HumanJointId } from '../AutoFitTypes.ts'

/*
 * Procedural humanoid used by the Auto Fit tests. It is built from simple
 * primitives (several meshes, like a real multi material model) so we know the
 * exact joint positions to compare the estimator against. No external assets.
 *
 * All proportions are expressed as a fraction of the total height.
 * Convention: +Y up, facing +Z, character left = +X.
 */
export interface HumanoidProportions {
  ankle: number
  knee: number
  hip: number
  hip_x: number
  thigh_radius: number
  shin_radius: number
  foot_forward: number
  foot_back: number
  foot_height: number
  foot_width: number
  torso_bottom: number
  torso_top: number
  torso_radius_x: number
  torso_radius_z: number
  shoulder: number
  shoulder_x: number
  upper_arm_length: number
  upper_arm_radius: number
  forearm_length: number
  forearm_radius: number
  wrist_radius: number
  hand_length: number
  hand_width: number
  hand_thickness: number
  neck_top: number
  neck_radius: number
  head_radius: number
}

export const ADULT_PROPORTIONS: HumanoidProportions = {
  ankle: 0.05,
  knee: 0.28,
  hip: 0.52,
  hip_x: 0.065,
  thigh_radius: 0.045,
  shin_radius: 0.035,
  foot_forward: 0.13,
  foot_back: 0.035,
  foot_height: 0.06,
  foot_width: 0.05,
  torso_bottom: 0.48,
  torso_top: 0.83,
  torso_radius_x: 0.11,
  torso_radius_z: 0.065,
  shoulder: 0.80,
  shoulder_x: 0.12,
  upper_arm_length: 0.17,
  upper_arm_radius: 0.035,
  forearm_length: 0.15,
  forearm_radius: 0.028,
  wrist_radius: 0.018,
  hand_length: 0.10,
  hand_width: 0.06,
  hand_thickness: 0.02,
  neck_top: 0.87,
  neck_radius: 0.035,
  head_radius: 0.07
}

// big head, short limbs
export const CHIBI_PROPORTIONS: HumanoidProportions = {
  ankle: 0.04,
  knee: 0.17,
  hip: 0.32,
  hip_x: 0.07,
  thigh_radius: 0.05,
  shin_radius: 0.045,
  foot_forward: 0.11,
  foot_back: 0.035,
  foot_height: 0.05,
  foot_width: 0.06,
  torso_bottom: 0.29,
  torso_top: 0.58,
  torso_radius_x: 0.13,
  torso_radius_z: 0.08,
  shoulder: 0.55,
  shoulder_x: 0.14,
  upper_arm_length: 0.10,
  upper_arm_radius: 0.04,
  forearm_length: 0.09,
  forearm_radius: 0.035,
  wrist_radius: 0.024,
  hand_length: 0.07,
  hand_width: 0.07,
  hand_thickness: 0.025,
  neck_top: 0.61,
  neck_radius: 0.05,
  head_radius: 0.2
}

export type SyntheticHumanoidPart = 'left_leg' | 'head' | 'arms'

export interface SyntheticHumanoidOptions {
  height?: number
  arm_angle_degrees?: number // 0 = T-pose, ~45 = A-pose
  proportions?: HumanoidProportions
  omit?: SyntheticHumanoidPart[]
  with_sword?: boolean
  root_transform?: Matrix4
}

export interface SyntheticHumanoid {
  root: Group
  height: number
  // ground truth in world space (after root_transform)
  truth: Partial<Record<HumanJointId, Vector3>>
}

const material = new MeshBasicMaterial()

function limb (start: Vector3, end: Vector3, radius: number, name: string): Mesh {
  const direction = end.clone().sub(start)
  const length = direction.length()
  const mesh = new Mesh(new CapsuleGeometry(radius, length, 4, 12), material)
  mesh.name = name
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  return mesh
}

// open cylinder that narrows from start to end, like a forearm towards the wrist
function tapered_limb (start: Vector3, end: Vector3, start_radius: number, end_radius: number, name: string): Mesh {
  const direction = end.clone().sub(start)
  const mesh = new Mesh(new CylinderGeometry(end_radius, start_radius, direction.length(), 16, 1, true), material)
  mesh.name = name
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  return mesh
}

function box_between (start: Vector3, end: Vector3, size_x: number, size_z: number, name: string): Mesh {
  const direction = end.clone().sub(start)
  const mesh = new Mesh(new BoxGeometry(size_x, direction.length(), size_z), material)
  mesh.name = name
  mesh.position.copy(start).add(end).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize())
  return mesh
}

export function build_synthetic_humanoid (options: SyntheticHumanoidOptions = {}): SyntheticHumanoid {
  const h = options.height ?? 1.8
  const p = options.proportions ?? ADULT_PROPORTIONS
  const omit = options.omit ?? []
  const angle = (options.arm_angle_degrees ?? 0) * Math.PI / 180

  const root = new Group()
  root.name = 'Synthetic Humanoid'
  const body = new Group() // untransformed body, root carries the optional transform
  root.add(body)

  const truth: Partial<Record<HumanJointId, Vector3>> = {}
  const add = (object: Object3D): void => { body.add(object) }

  // torso: elliptical cylinder from crotch to base of the neck
  const torso_height = (p.torso_top - p.torso_bottom) * h
  const torso = new Mesh(new CylinderGeometry(p.torso_radius_x * h, p.torso_radius_x * h * 0.92, torso_height, 32), material)
  torso.name = 'torso'
  torso.position.set(0, (p.torso_bottom * h) + torso_height / 2, 0)
  torso.scale.set(1, 1, p.torso_radius_z / p.torso_radius_x)
  add(torso)

  truth.pelvis = new Vector3(0, p.hip * h, 0)
  // like the Mesh2Motion rig, neck_01 starts at the base of the neck, level with the shoulders
  truth.neck = new Vector3(0, p.shoulder * h, 0)

  if (!omit.includes('head')) {
    const neck_start = new Vector3(0, (p.torso_top - 0.01) * h, 0)
    const neck_end = new Vector3(0, p.neck_top * h, 0)
    const neck = new Mesh(new CylinderGeometry(p.neck_radius * h, p.neck_radius * h, neck_end.y - neck_start.y, 20), material)
    neck.name = 'neck'
    neck.position.copy(neck_start).add(neck_end).multiplyScalar(0.5)
    add(neck)

    const head = new Mesh(new SphereGeometry(p.head_radius * h, 32, 24), material)
    head.name = 'head'
    head.position.set(0, h - p.head_radius * h, 0)
    add(head)
    // head bone in the middle of the visible neck, see HumanJointEstimator PROPORTIONS
    const head_bottom = 1 - 2 * p.head_radius
    truth.head = new Vector3(0, (p.torso_top + Math.min(p.neck_top, head_bottom)) / 2 * h, 0)
  }

  // legs. side = +1 for left (+X), -1 for right
  const build_leg = (side: number, suffix: 'l' | 'r'): void => {
    const hip = new Vector3(side * p.hip_x * h, p.hip * h, 0)
    const knee = new Vector3(side * p.hip_x * h, p.knee * h, 0)
    const ankle = new Vector3(side * p.hip_x * h, p.ankle * h, 0)
    add(limb(hip, knee, p.thigh_radius * h, `thigh_${suffix}`))
    add(limb(knee, ankle, p.shin_radius * h, `shin_${suffix}`))

    const foot_length = (p.foot_forward + p.foot_back) * h
    const foot = new Mesh(new BoxGeometry(p.foot_width * h, p.foot_height * h, foot_length), material)
    foot.name = `foot_${suffix}`
    foot.position.set(side * p.hip_x * h, p.foot_height * h / 2, (p.foot_forward - p.foot_back) * h / 2)
    add(foot)

    truth[`hip_${suffix}`] = hip
    truth[`knee_${suffix}`] = knee
    truth[`ankle_${suffix}`] = ankle
    truth[`ball_${suffix}`] = new Vector3(side * p.hip_x * h, 0.02 * h, p.foot_forward * h * 0.7)
    truth[`toe_${suffix}`] = new Vector3(side * p.hip_x * h, 0.01 * h, p.foot_forward * h)
  }

  if (!omit.includes('left_leg')) {
    build_leg(1, 'l')
  }
  build_leg(-1, 'r')

  // arms rotate down from horizontal by the arm angle
  const build_arm = (side: number, suffix: 'l' | 'r'): void => {
    const direction = new Vector3(side * Math.cos(angle), -Math.sin(angle), 0)
    const shoulder = new Vector3(side * p.shoulder_x * h, p.shoulder * h, 0)
    const elbow = shoulder.clone().addScaledVector(direction, p.upper_arm_length * h)
    const wrist = elbow.clone().addScaledVector(direction, p.forearm_length * h)
    const finger_tip = wrist.clone().addScaledVector(direction, p.hand_length * h)

    add(limb(shoulder, elbow, p.upper_arm_radius * h, `upperarm_${suffix}`))
    add(tapered_limb(elbow, wrist, p.forearm_radius * h, p.wrist_radius * h, `forearm_${suffix}`))
    add(box_between(wrist, finger_tip, p.hand_thickness * h, p.hand_width * h, `hand_${suffix}`))

    truth[`shoulder_${suffix}`] = shoulder
    truth[`elbow_${suffix}`] = elbow
    truth[`wrist_${suffix}`] = wrist
    truth[`fingertip_${suffix}`] = finger_tip

    if (options.with_sword === true && suffix === 'r') {
      const grip = wrist.clone().addScaledVector(direction, p.hand_length * h * 0.5)
      const blade_tip = grip.clone().add(new Vector3(0, -0.1 * h, 0.5 * h))
      add(box_between(grip, blade_tip, 0.01 * h, 0.03 * h, 'sword'))
    }
  }

  if (!omit.includes('arms')) {
    build_arm(1, 'l')
    build_arm(-1, 'r')
  }

  if (options.root_transform !== undefined) {
    root.applyMatrix4(options.root_transform)
  }
  root.updateMatrixWorld(true)

  // express ground truth in world space as well
  Object.values(truth).forEach((position) => {
    position.applyMatrix4(root.matrixWorld)
  })

  return { root, height: h * root.scale.y, truth }
}
