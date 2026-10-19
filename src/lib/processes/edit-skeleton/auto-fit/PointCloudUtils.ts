/*
 * Small numeric helpers shared by the Auto Fit estimators.
 * Kept free of Three.js objects so they are cheap and easy to test.
 */
export class PointCloudUtils {
  /**
   * Linear interpolated percentile (p from 0 to 1). Returns NaN for an empty list.
   * The input array is not modified.
   */
  public static percentile (values: ArrayLike<number>, p: number): number {
    if (values.length === 0) { return NaN }
    const sorted = Array.from(values).sort((a, b) => a - b)
    const position = Math.min(Math.max(p, 0), 1) * (sorted.length - 1)
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const t = position - lower
    return sorted[lower] * (1 - t) + sorted[upper] * t
  }

  public static median (values: ArrayLike<number>): number {
    return PointCloudUtils.percentile(values, 0.5)
  }

  public static mean (values: ArrayLike<number>): number {
    if (values.length === 0) { return NaN }
    let sum = 0
    for (let i = 0; i < values.length; i++) { sum += values[i] }
    return sum / values.length
  }

  public static clamp (value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }

  public static lerp (a: number, b: number, t: number): number {
    return a + (b - a) * t
  }

  /**
   * Collect one coordinate (0 = x, 1 = y, 2 = z) of every point accepted by the filter
   */
  public static collect_axis (points: Float32Array, point_count: number, axis: number, filter: (index: number) => boolean): number[] {
    const values: number[] = []
    for (let i = 0; i < point_count; i++) {
      if (filter(i)) {
        values.push(points[i * 3 + axis])
      }
    }
    return values
  }
}
