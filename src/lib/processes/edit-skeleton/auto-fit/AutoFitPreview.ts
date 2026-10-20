import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  type Object3D,
  type Texture
} from 'three'
import { confidence_level, type AutoFitResult, type ConfidenceLevel, type HumanJointId } from './AutoFitTypes.ts'

// same colors as the swatches in auto-fit.css
const CONFIDENCE_COLORS: Record<ConfidenceLevel, number> = {
  high: 0x4caf50,
  medium: 0xffc107,
  low: 0xf44336
}

// pairs of joints drawn as lines, so the proposal reads as a skeleton
const PREVIEW_LINKS: Array<[HumanJointId, HumanJointId]> = [
  ['pelvis', 'spine_lower'], ['spine_lower', 'spine_middle'], ['spine_middle', 'spine_upper'],
  ['spine_upper', 'neck'], ['neck', 'head'], ['head', 'head_top'],
  ['spine_upper', 'clavicle_l'], ['clavicle_l', 'shoulder_l'], ['shoulder_l', 'elbow_l'], ['elbow_l', 'wrist_l'], ['wrist_l', 'fingertip_l'],
  ['spine_upper', 'clavicle_r'], ['clavicle_r', 'shoulder_r'], ['shoulder_r', 'elbow_r'], ['elbow_r', 'wrist_r'], ['wrist_r', 'fingertip_r'],
  ['pelvis', 'hip_l'], ['hip_l', 'knee_l'], ['knee_l', 'ankle_l'], ['ankle_l', 'ball_l'], ['ball_l', 'toe_l'],
  ['pelvis', 'hip_r'], ['hip_r', 'knee_r'], ['knee_r', 'ankle_r'], ['ankle_r', 'ball_r'], ['ball_r', 'toe_r']
]

/*
 * AutoFitPreview
 * Draws the proposed joints (colored by confidence) on top of the model while
 * the user reviews them. It never touches the editable skeleton.
 */
export class AutoFitPreview {
  private preview_group: Group | null = null
  private parent: Object3D | null = null

  constructor (private readonly joint_texture: Texture | null = null) {}

  public show (parent: Object3D, result: AutoFitResult): void {
    this.clear()
    if (result.joints.length === 0) { return }

    const positions: number[] = []
    const colors: number[] = []
    const color = new Color()
    result.joints.forEach((joint) => {
      positions.push(...joint.world_position)
      color.setHex(CONFIDENCE_COLORS[confidence_level(joint.confidence)])
      colors.push(color.r, color.g, color.b)
    })

    const point_geometry = new BufferGeometry()
    point_geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    point_geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
    const points = new Points(point_geometry, new PointsMaterial({
      size: 16,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
      transparent: true,
      map: this.joint_texture
    }))
    points.renderOrder = 101

    const by_id = new Map(result.joints.map(joint => [joint.id, joint.world_position]))
    const line_positions: number[] = []
    PREVIEW_LINKS.forEach(([from, to]) => {
      const start = by_id.get(from)
      const end = by_id.get(to)
      if (start !== undefined && end !== undefined) {
        line_positions.push(...start, ...end)
      }
    })
    const line_geometry = new BufferGeometry()
    line_geometry.setAttribute('position', new Float32BufferAttribute(line_positions, 3))
    const lines = new LineSegments(line_geometry, new LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthTest: false
    }))
    lines.renderOrder = 100

    this.preview_group = new Group()
    this.preview_group.name = 'Auto Fit Preview'
    this.preview_group.add(lines, points)
    this.parent = parent
    parent.add(this.preview_group)
  }

  public is_visible (): boolean {
    return this.preview_group !== null
  }

  public clear (): void {
    if (this.preview_group === null) { return }
    this.parent?.remove(this.preview_group)
    this.preview_group.traverse((object) => {
      const drawable = object as Points | LineSegments
      if (drawable.geometry !== undefined) {
        drawable.geometry.dispose()
        ;(drawable.material as PointsMaterial | LineBasicMaterial).dispose()
      }
    })
    this.preview_group = null
    this.parent = null
  }
}
