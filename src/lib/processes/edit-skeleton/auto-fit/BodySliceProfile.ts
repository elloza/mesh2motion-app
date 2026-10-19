import { type GeometrySnapshot } from './AutoFitTypes.ts'
import { type BodyFrame } from './BodyFrameEstimator.ts'

/**
 * A group of points in one horizontal slice that are connected along X.
 * For a standing human, a slice through the thighs has two clusters (one per
 * leg) while a slice through the belly has one.
 */
export interface SliceCluster {
  min_x: number
  max_x: number
  mean_x: number
  mean_z: number
  min_z: number
  max_z: number
  count: number
}

export interface HorizontalSlice {
  index: number
  y_min: number
  y_max: number
  y_center: number
  point_indices: number[]
  clusters: SliceCluster[]
}

/*
 * BodySliceProfile
 * Cuts the sampled surface into horizontal slices and groups the points of each
 * slice into clusters along X. Most of the joint estimation reads from this.
 */
export class BodySliceProfile {
  public readonly slices: HorizontalSlice[] = []
  public readonly slice_height: number

  constructor (
    private readonly snapshot: GeometrySnapshot,
    private readonly frame: BodyFrame,
    slice_count: number = 120,
    cluster_gap_ratio: number = 0.015
  ) {
    this.slice_height = frame.height / slice_count

    const buckets: number[][] = Array.from({ length: slice_count }, () => [])
    const points = snapshot.points
    for (let i = 0; i < snapshot.point_count; i++) {
      const slice_index = Math.min(slice_count - 1, Math.max(0, Math.floor((points[i * 3 + 1] - frame.floor_y) / this.slice_height)))
      buckets[slice_index].push(i)
    }

    const cluster_gap = frame.height * cluster_gap_ratio
    for (let s = 0; s < slice_count; s++) {
      const y_min = frame.floor_y + s * this.slice_height
      this.slices.push({
        index: s,
        y_min,
        y_max: y_min + this.slice_height,
        y_center: y_min + this.slice_height / 2,
        point_indices: buckets[s],
        clusters: BodySliceProfile.cluster_along_x(points, buckets[s], cluster_gap)
      })
    }
  }

  public slice_at (y: number): HorizontalSlice {
    const index = Math.floor((y - this.frame.floor_y) / this.slice_height)
    return this.slices[Math.min(this.slices.length - 1, Math.max(0, index))]
  }

  /**
   * Slices whose centre lies between two heights (inclusive)
   */
  public slices_between (y_low: number, y_high: number): HorizontalSlice[] {
    return this.slices.filter((slice) => slice.y_center >= y_low && slice.y_center <= y_high)
  }

  /**
   * The cluster that crosses the body centre line, if any
   */
  public central_cluster (slice: HorizontalSlice): SliceCluster | null {
    const center_x = this.frame.center_x
    return slice.clusters.find((cluster) => cluster.min_x <= center_x && cluster.max_x >= center_x) ?? null
  }

  /**
   * Half width of the central cluster, measured from the centre line. Zero when
   * nothing crosses the centre line.
   */
  public central_half_width (slice: HorizontalSlice): number {
    const cluster = this.central_cluster(slice)
    if (cluster === null) { return 0 }
    return Math.max(this.frame.center_x - cluster.min_x, cluster.max_x - this.frame.center_x)
  }

  /**
   * Closest cluster to the centre line on one side (+1 = left / +X, -1 = right / -X)
   * that does not cross the centre line and starts within max_offset of it.
   * Used to find the legs, the closest cluster on each side, so hanging hands
   * further out are ignored.
   */
  public inner_side_cluster (slice: HorizontalSlice, side: number, max_offset: number): SliceCluster | null {
    const center_x = this.frame.center_x
    let best: SliceCluster | null = null
    let best_distance = Infinity
    slice.clusters.forEach((cluster) => {
      const crosses_center = cluster.min_x <= center_x && cluster.max_x >= center_x
      if (crosses_center) { return }
      const offset = (cluster.mean_x - center_x) * side
      if (offset <= 0 || offset > max_offset) { return }
      const inner_edge = side > 0 ? cluster.min_x - center_x : center_x - cluster.max_x
      if (inner_edge < best_distance) {
        best_distance = inner_edge
        best = cluster
      }
    })
    return best
  }

  /**
   * Average Z of the points close to the centre line in a slice. For a torso
   * slice this is the middle between chest and back.
   */
  public core_z (slice: HorizontalSlice, core_half_width: number): number | null {
    const points = this.snapshot.points
    let sum = 0
    let count = 0
    slice.point_indices.forEach((i) => {
      if (Math.abs(points[i * 3] - this.frame.center_x) < core_half_width) {
        sum += points[i * 3 + 2]
        count++
      }
    })
    return count > 0 ? sum / count : null
  }

  /**
   * Sort the points of a slice by X and split them where the gap between
   * neighbours is bigger than cluster_gap.
   */
  public static cluster_along_x (points: Float32Array, indices: number[], cluster_gap: number): SliceCluster[] {
    if (indices.length === 0) { return [] }

    const sorted = [...indices].sort((a, b) => points[a * 3] - points[b * 3])
    const clusters: SliceCluster[] = []
    let start = 0

    for (let k = 1; k <= sorted.length; k++) {
      const is_end = k === sorted.length
      const gap = is_end ? Infinity : points[sorted[k] * 3] - points[sorted[k - 1] * 3]
      if (gap > cluster_gap) {
        clusters.push(BodySliceProfile.summarize(points, sorted, start, k))
        start = k
      }
    }

    return clusters
  }

  private static summarize (points: Float32Array, sorted: number[], start: number, end: number): SliceCluster {
    let sum_x = 0
    let sum_z = 0
    let min_z = Infinity
    let max_z = -Infinity
    for (let k = start; k < end; k++) {
      const i = sorted[k]
      sum_x += points[i * 3]
      sum_z += points[i * 3 + 2]
      min_z = Math.min(min_z, points[i * 3 + 2])
      max_z = Math.max(max_z, points[i * 3 + 2])
    }
    const count = end - start
    return {
      min_x: points[sorted[start] * 3],
      max_x: points[sorted[end - 1] * 3],
      mean_x: sum_x / count,
      mean_z: sum_z / count,
      min_z,
      max_z,
      count
    }
  }
}
