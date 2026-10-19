import { Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three'
import { type GeometrySnapshot } from './AutoFitTypes.ts'

/*
 * GeometrySampler
 * Turns the loaded model into a GeometrySnapshot: a fixed number of points spread
 * evenly over the surface (area weighted), in world space.
 *
 * - Read only: geometry, materials and transforms of the model are never changed.
 * - Deterministic: a seeded random generator, so the same model always gives
 *   the same samples (and therefore the same fit).
 * - Bounded cost: the analysis works on the samples, not on every triangle, so a
 *   very dense model only costs one pass to measure triangle areas.
 */
export class GeometrySampler {
  public static readonly DEFAULT_SAMPLE_COUNT: number = 40000

  public static sample (root: Object3D, sample_count: number = GeometrySampler.DEFAULT_SAMPLE_COUNT, seed: number = 1): GeometrySnapshot {
    root.updateWorldMatrix(true, true)

    const triangle_sources: TriangleSource[] = []
    root.traverse((object: Object3D) => {
      const mesh = object as Mesh
      if (mesh.isMesh !== true) { return }
      const source = GeometrySampler.triangle_source_from_mesh(mesh)
      if (source !== null) {
        triangle_sources.push(source)
      }
    })

    // measure triangle areas so bigger triangles receive more samples
    let total_triangle_count = 0
    triangle_sources.forEach((source) => { total_triangle_count += source.triangle_count })

    const cumulative_areas = new Float64Array(total_triangle_count)
    const bounds_min: [number, number, number] = [Infinity, Infinity, Infinity]
    const bounds_max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    let running_area = 0
    let triangle_offset = 0

    const a = new Vector3()
    const b = new Vector3()
    const c = new Vector3()

    triangle_sources.forEach((source) => {
      for (let i = 0; i < source.triangle_count; i++) {
        let area = 0
        if (source.read_triangle(i, a, b, c)) {
          area = GeometrySampler.triangle_area(a, b, c)
          if (Number.isFinite(area) && area > 0) {
            GeometrySampler.expand_bounds(bounds_min, bounds_max, a)
            GeometrySampler.expand_bounds(bounds_min, bounds_max, b)
            GeometrySampler.expand_bounds(bounds_min, bounds_max, c)
          } else {
            area = 0 // degenerate triangle, never sampled
          }
        }
        running_area += area
        cumulative_areas[triangle_offset + i] = running_area
      }
      triangle_offset += source.triangle_count
    })

    const total_area = running_area
    const has_surface = total_area > 0 && sample_count > 0
    const points = new Float32Array(has_surface ? sample_count * 3 : 0)

    if (has_surface) {
      const random = GeometrySampler.create_random(seed)
      for (let k = 0; k < sample_count; k++) {
        const global_triangle = GeometrySampler.find_triangle(cumulative_areas, random() * total_area)
        const [source, local_triangle] = GeometrySampler.locate_triangle(triangle_sources, global_triangle)
        source.read_triangle(local_triangle, a, b, c)

        // uniform point inside the triangle
        const r1 = Math.sqrt(random())
        const r2 = random()
        const wa = 1 - r1
        const wb = r1 * (1 - r2)
        const wc = r1 * r2
        points[k * 3] = a.x * wa + b.x * wb + c.x * wc
        points[k * 3 + 1] = a.y * wa + b.y * wb + c.y * wc
        points[k * 3 + 2] = a.z * wa + b.z * wb + c.z * wc
      }
    }

    return {
      points,
      point_count: has_surface ? sample_count : 0,
      bounds_min: has_surface ? bounds_min : [0, 0, 0],
      bounds_max: has_surface ? bounds_max : [0, 0, 0],
      source_mesh_count: triangle_sources.length,
      source_triangle_count: total_triangle_count
    }
  }

  private static triangle_source_from_mesh (mesh: Mesh): TriangleSource | null {
    const geometry: BufferGeometry | undefined = mesh.geometry
    const position_attribute = geometry?.getAttribute('position')
    if (position_attribute === undefined || position_attribute.count < 3) {
      return null
    }

    // transform every vertex to world space once
    const world_positions = new Float32Array(position_attribute.count * 3)
    const vertex = new Vector3()
    for (let i = 0; i < position_attribute.count; i++) {
      vertex.fromBufferAttribute(position_attribute, i).applyMatrix4(mesh.matrixWorld)
      world_positions[i * 3] = vertex.x
      world_positions[i * 3 + 1] = vertex.y
      world_positions[i * 3 + 2] = vertex.z
    }

    const index = geometry.getIndex()
    const triangle_count = index !== null
      ? Math.floor(index.count / 3)
      : Math.floor(position_attribute.count / 3)

    if (triangle_count === 0) {
      return null
    }

    const vertex_count = position_attribute.count
    const read_triangle = (triangle: number, a: Vector3, b: Vector3, c: Vector3): boolean => {
      const ia = index !== null ? index.getX(triangle * 3) : triangle * 3
      const ib = index !== null ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
      const ic = index !== null ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
      if (ia >= vertex_count || ib >= vertex_count || ic >= vertex_count) {
        return false
      }
      a.fromArray(world_positions, ia * 3)
      b.fromArray(world_positions, ib * 3)
      c.fromArray(world_positions, ic * 3)
      return true
    }

    return { triangle_count, read_triangle }
  }

  private static triangle_area (a: Vector3, b: Vector3, c: Vector3): number {
    const abx = b.x - a.x
    const aby = b.y - a.y
    const abz = b.z - a.z
    const acx = c.x - a.x
    const acy = c.y - a.y
    const acz = c.z - a.z
    const cross_x = aby * acz - abz * acy
    const cross_y = abz * acx - abx * acz
    const cross_z = abx * acy - aby * acx
    return 0.5 * Math.sqrt(cross_x * cross_x + cross_y * cross_y + cross_z * cross_z)
  }

  private static expand_bounds (min: number[], max: number[], point: Vector3): void {
    min[0] = Math.min(min[0], point.x)
    min[1] = Math.min(min[1], point.y)
    min[2] = Math.min(min[2], point.z)
    max[0] = Math.max(max[0], point.x)
    max[1] = Math.max(max[1], point.y)
    max[2] = Math.max(max[2], point.z)
  }

  // binary search for the first triangle whose cumulative area reaches the target
  private static find_triangle (cumulative_areas: Float64Array, target: number): number {
    let low = 0
    let high = cumulative_areas.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if (cumulative_areas[middle] < target) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low
  }

  private static locate_triangle (sources: TriangleSource[], global_triangle: number): [TriangleSource, number] {
    let remaining = global_triangle
    for (const source of sources) {
      if (remaining < source.triangle_count) {
        return [source, remaining]
      }
      remaining -= source.triangle_count
    }
    const last = sources[sources.length - 1]
    return [last, last.triangle_count - 1]
  }

  // mulberry32: tiny seeded generator so results are reproducible
  private static create_random (seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6D2B79F5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
}

interface TriangleSource {
  triangle_count: number
  read_triangle: (triangle: number, a: Vector3, b: Vector3, c: Vector3) => boolean
}
