import { type BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute } from 'three'

/**
 * Finds every vertex that sits at the same position as a given vertex. UV seams
 * and hard normals split one surface point into several vertices, and they all
 * need the same skin weights or the mesh tears when it deforms.
 *
 * "Same position" means the x, y and z coordinates are equal when rounded to 6
 * decimals with toFixed(6). That rule is unchanged from the original lookup.
 *
 * The original built a string key for every vertex up front. On dense meshes
 * that means millions of strings, while the smoother only asks about the few
 * vertices on bone boundaries. Here every vertex goes into a numeric spatial
 * hash instead, and string keys are built only for the vertex being asked about
 * and the few vertices near it.
 */
export class SharedPositionLookup {
  // Cell size of the spatial hash. Two coordinates that round to the same 6
  // decimals are at most 1e-6 apart, so they always land in the same cell or
  // in neighboring cells.
  private static readonly cells_per_unit: number = 1e4

  // Numeric pre-filter, set a little above the 1e-6 bound to allow for floating point rounding
  private static readonly max_matching_offset: number = 2e-6

  private readonly position_attribute: BufferAttribute | InterleavedBufferAttribute
  private readonly bucket_mask: number
  private readonly bucket_heads: Int32Array // first vertex in each hash bucket, -1 when empty
  private readonly next_in_bucket: Int32Array // linked list through the vertices of a bucket
  private readonly shared_by_key = new Map<string, number[]>()

  constructor (geometry: BufferGeometry) {
    this.position_attribute = geometry.attributes.position
    const vertex_count = this.position_attribute.array.length / 3

    // power of two bucket count with at least 2 buckets per vertex keeps chains short
    let bucket_count = 1
    while (bucket_count < vertex_count * 2) bucket_count *= 2
    this.bucket_mask = bucket_count - 1
    this.bucket_heads = new Int32Array(bucket_count).fill(-1)
    this.next_in_bucket = new Int32Array(vertex_count)

    for (let i = 0; i < vertex_count; i++) {
      const bucket = this.bucket_for_cell(
        this.cell_coordinate(this.position_attribute.getX(i)),
        this.cell_coordinate(this.position_attribute.getY(i)),
        this.cell_coordinate(this.position_attribute.getZ(i))
      )
      this.next_in_bucket[i] = this.bucket_heads[bucket]
      this.bucket_heads[bucket] = i
    }
  }

  /**
   * All vertices at the same position as the given vertex (itself included),
   * in ascending index order. Repeat calls return the same cached array.
   */
  public get_shared_vertices (vertex: number): number[] {
    const key = this.position_key(vertex)
    const cached = this.shared_by_key.get(key)
    if (cached !== undefined) return cached

    const x = this.position_attribute.getX(vertex)
    const y = this.position_attribute.getY(vertex)
    const z = this.position_attribute.getZ(vertex)
    const cell_x = this.cell_coordinate(x)
    const cell_y = this.cell_coordinate(y)
    const cell_z = this.cell_coordinate(z)
    const max_offset = SharedPositionLookup.max_matching_offset

    // neighboring cells can hash to the same bucket, so walk each bucket only once
    const visited_buckets: number[] = []
    const shared: number[] = []

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.bucket_for_cell(cell_x + dx, cell_y + dy, cell_z + dz)
          if (visited_buckets.includes(bucket)) continue
          visited_buckets.push(bucket)

          for (let other = this.bucket_heads[bucket]; other !== -1; other = this.next_in_bucket[other]) {
            // cheap numeric check first; the string comparison is the exact rule
            if (Math.abs(this.position_attribute.getX(other) - x) > max_offset ||
              Math.abs(this.position_attribute.getY(other) - y) > max_offset ||
              Math.abs(this.position_attribute.getZ(other) - z) > max_offset) {
              continue
            }
            if (this.position_key(other) === key) {
              shared.push(other)
            }
          }
        }
      }
    }

    shared.sort((a, b) => a - b)
    this.shared_by_key.set(key, shared)
    return shared
  }

  private position_key (vertex: number): string {
    const x = this.position_attribute.getX(vertex)
    const y = this.position_attribute.getY(vertex)
    const z = this.position_attribute.getZ(vertex)
    return `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`
  }

  private cell_coordinate (value: number): number {
    return Math.floor(value * SharedPositionLookup.cells_per_unit)
  }

  private bucket_for_cell (cell_x: number, cell_y: number, cell_z: number): number {
    return (Math.imul(cell_x, 73856093) ^ Math.imul(cell_y, 19349663) ^ Math.imul(cell_z, 83492791)) & this.bucket_mask
  }
}
