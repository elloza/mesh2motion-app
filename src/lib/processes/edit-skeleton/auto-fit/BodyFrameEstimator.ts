import { type AutoFitOptions, type GeometrySnapshot } from './AutoFitTypes.ts'
import { PointCloudUtils } from './PointCloudUtils.ts'

export type FacingDirection = 'front' | 'back' | 'ambiguous'

export interface BodyFrame {
  floor_y: number
  top_y: number
  height: number
  width: number
  depth: number
  // centre line of the body. Not the bounding box centre, so a prop or an
  // asymmetric pose does not drag it sideways
  center_x: number
  center_z: number
  facing: FacingDirection
  facing_confidence: number
}

export interface BodyFrameResult {
  frame: BodyFrame | null
  unsupported_reason: string | null
  warnings: string[]
}

/*
 * BodyFrameEstimator
 * Works out the basic measurements of the body (floor, height, centre line) and
 * checks whether the model can be fitted at all: it has to stand upright (+Y),
 * be roughly human shaped and face the front (+Z) like the rig template.
 */
export class BodyFrameEstimator {
  public static readonly MIN_POINT_COUNT: number = 500

  public static estimate (snapshot: GeometrySnapshot, options: AutoFitOptions): BodyFrameResult {
    const warnings: string[] = []
    const unsupported = (reason: string): BodyFrameResult => ({ frame: null, unsupported_reason: reason, warnings })

    if (snapshot.point_count < BodyFrameEstimator.MIN_POINT_COUNT) {
      return unsupported('Not enough mesh surface to analyze.')
    }

    const [min_x, min_y, min_z] = snapshot.bounds_min
    const [max_x, max_y, max_z] = snapshot.bounds_max
    const height = max_y - min_y
    const width = max_x - min_x
    const depth = max_z - min_z

    if (!Number.isFinite(height) || height <= 1e-6) {
      return unsupported('The model has no height.')
    }

    // a standing human is much taller than it is deep. Animals, lying models
    // and models with the wrong up axis fail here
    if (depth > height * 0.75) {
      return unsupported('The model does not look like an upright humanoid. Make sure it stands up (+Y) and faces the front.')
    }

    // a T-pose is about as wide as it is tall
    if (width > height * 1.5) {
      return unsupported('The model is much wider than it is tall, so it does not look like a standing humanoid.')
    }

    const points = snapshot.points
    const count = snapshot.point_count
    const height_ratio = (index: number): number => (points[index * 3 + 1] - min_y) / height

    // centre line from the upper body (above the legs, so a missing leg does not
    // shift it). Re-centre a couple of times ignoring far points, so arms or a
    // prop held to one side do not drag it sideways
    let center_x = PointCloudUtils.median(PointCloudUtils.collect_axis(points, count, 0, (i) => {
      const t = height_ratio(i)
      return t > 0.6 && t < 0.95
    }))
    for (let iteration = 0; iteration < 2; iteration++) {
      const previous_center = center_x
      const near_center = PointCloudUtils.collect_axis(points, count, 0, (i) => {
        const t = height_ratio(i)
        return t > 0.6 && t < 0.95 && Math.abs(points[i * 3] - previous_center) < height * 0.12
      })
      if (near_center.length > 0) {
        center_x = PointCloudUtils.median(near_center)
      }
    }

    const body_z = PointCloudUtils.collect_axis(points, count, 2, (i) => {
      const t = height_ratio(i)
      return t > 0.6 && t < 0.95 && Math.abs(points[i * 3] - center_x) < height * 0.08
    })
    const center_z = body_z.length > 0 ? PointCloudUtils.median(body_z) : (min_z + max_z) / 2

    const [facing, facing_confidence] = BodyFrameEstimator.detect_facing(points, count, min_y, height)

    let final_facing: FacingDirection = facing
    let final_facing_confidence = facing_confidence

    if (options.facing === 'back') {
      return unsupported('The model faces backwards. Go back and use "Rotate Model to face front" before fitting.')
    } else if (options.facing === 'front') {
      final_facing = 'front'
      final_facing_confidence = 1
    } else if (facing === 'back') {
      return unsupported('The model seems to face backwards (-Z). Go back and use "Rotate Model to face front", or set Facing to Front if this is wrong.')
    } else if (facing === 'ambiguous') {
      warnings.push('Could not confirm which way the model faces from its feet. Assuming it faces the front (+Z).')
    }

    return {
      frame: {
        floor_y: min_y,
        top_y: max_y,
        height,
        width,
        depth,
        center_x,
        center_z,
        facing: final_facing,
        facing_confidence: final_facing_confidence
      },
      unsupported_reason: null,
      warnings
    }
  }

  /**
   * Feet stick out forward from the ankles a lot more than the heels stick out
   * backwards. Compare the reach of the bottom slice in +Z and -Z against the
   * centre of the shins.
   */
  public static detect_facing (points: Float32Array, count: number, floor_y: number, height: number): [FacingDirection, number] {
    const sole_z: number[] = []
    const shin_z: number[] = []

    for (let i = 0; i < count; i++) {
      const t = (points[i * 3 + 1] - floor_y) / height
      if (t < 0.03) {
        sole_z.push(points[i * 3 + 2])
      } else if (t > 0.08 && t < 0.16) {
        shin_z.push(points[i * 3 + 2])
      }
    }

    if (sole_z.length < 20 || shin_z.length < 20) {
      return ['ambiguous', 0.5]
    }

    const shin_center = PointCloudUtils.mean(shin_z)
    const forward_reach = PointCloudUtils.percentile(sole_z, 0.98) - shin_center
    const backward_reach = shin_center - PointCloudUtils.percentile(sole_z, 0.02)

    if (forward_reach > backward_reach * 1.35) {
      return ['front', PointCloudUtils.clamp(forward_reach / Math.max(backward_reach, 1e-6) / 3, 0.6, 1)]
    }
    if (backward_reach > forward_reach * 1.35) {
      return ['back', PointCloudUtils.clamp(backward_reach / Math.max(forward_reach, 1e-6) / 3, 0.6, 1)]
    }
    return ['ambiguous', 0.5]
  }
}
