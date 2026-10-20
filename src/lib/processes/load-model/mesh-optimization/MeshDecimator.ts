import { BufferAttribute, BufferGeometry, type InterleavedBufferAttribute, type TypedArray } from 'three'

// The parts of meshoptimizer's simplifier this class uses. The library is only
// downloaded when the user actually optimizes a model (see load_simplifier()).
export interface MeshSimplifier {
  simplifyWithAttributes: (
    indices: Uint32Array,
    vertex_positions: Float32Array,
    vertex_positions_stride: number,
    vertex_attributes: Float32Array,
    vertex_attributes_stride: number,
    attribute_weights: number[],
    vertex_lock: Uint8Array | null,
    target_index_count: number,
    target_error: number,
    flags?: Array<'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive'>
  ) => [Uint32Array, number]
}

export interface DecimationResult {
  geometry: BufferGeometry
  // for each vertex of the new geometry, the vertex of the source geometry it was copied from
  source_vertex_ids: Uint32Array
  source_triangle_count: number
  triangle_count: number
  // simplification error relative to the mesh size (0.001 = 0.1% of its extent)
  relative_error: number
}

/**
 * Reduces a mesh's triangle count for game engines, using meshoptimizer's
 * edge-collapse simplifier.
 *
 * Collapses only ever move a vertex onto another existing vertex, so every
 * vertex that survives keeps its exact position, normal and UV. That is what
 * lets the textures be reused as they are, without re-baking them. UV seams and
 * material boundaries stay intact, and the mesh's open borders are locked so
 * separate parts (eyes, clothing) do not shrink away from each other.
 */
export class MeshDecimator {
  // how much normals and UVs count compared to the position error when picking collapses
  private static readonly normal_weight: number = 0.5
  private static readonly uv_weight: number = 1.0

  /**
   * Loads the simplifier (about 70 KB including its WebAssembly module).
   * It is a dynamic import, so the library is kept out of the main bundle.
   */
  public static async load_simplifier (): Promise<MeshSimplifier> {
    const { MeshoptSimplifier } = await import('meshoptimizer/simplifier')
    await MeshoptSimplifier.ready
    return MeshoptSimplifier
  }

  /**
   * Splits a total triangle budget across meshes in proportion to their current
   * size. Meshes that are already within their share keep all their triangles.
   */
  public static distribute_triangle_budget (triangle_counts: number[], target_total: number): number[] {
    const total = triangle_counts.reduce((sum, count) => sum + count, 0)
    if (total <= target_total) return [...triangle_counts]

    const ratio = target_total / total
    return triangle_counts.map(count => Math.min(count, Math.max(1, Math.floor(count * ratio))))
  }

  /**
   * Simplifies a geometry down to about target_triangle_count triangles. The
   * source geometry is not modified. Geometries with material groups have each
   * group simplified on its own, so triangles never move between materials.
   */
  public static decimate_geometry (
    simplifier: MeshSimplifier,
    source: BufferGeometry,
    target_triangle_count: number
  ): DecimationResult {
    if (source.index === null) {
      return MeshDecimator.decimate_non_indexed_geometry(simplifier, source, target_triangle_count)
    }

    const positions = MeshDecimator.tightly_packed_positions(source)
    const indices = Uint32Array.from(source.index.array)
    const source_triangle_count = indices.length / 3

    const { attributes, stride, weights } = MeshDecimator.similarity_attributes(source)
    const ranges = MeshDecimator.index_ranges(source, indices.length)

    const simplified_parts: Uint32Array[] = []
    let worst_error = 0
    const budgets = MeshDecimator.distribute_triangle_budget(ranges.map(range => range.count / 3), target_triangle_count)

    ranges.forEach((range, range_index) => {
      const range_indices = indices.subarray(range.start, range.start + range.count)
      const [simplified, error] = simplifier.simplifyWithAttributes(
        range_indices, positions, 3, attributes, stride, weights, null,
        budgets[range_index] * 3,
        1.0, // no error limit: the triangle budget decides when to stop
        ['LockBorder']
      )
      simplified_parts.push(simplified)
      worst_error = Math.max(worst_error, error)
    })

    const { geometry, source_vertex_ids } = MeshDecimator.compact_geometry(source, simplified_parts, ranges)

    return {
      geometry,
      source_vertex_ids,
      source_triangle_count,
      triangle_count: (geometry.index?.count ?? 0) / 3,
      relative_error: worst_error
    }
  }

  /**
   * Non-indexed meshes (the FBX loader produces these) store every triangle
   * corner as its own vertex, so nothing is connected. Identical vertices are
   * welded into a compact indexed copy first. The leftover duplicates cannot
   * stay in the buffer: the simplifier would see them as seams and refuse to
   * collapse anything.
   */
  private static decimate_non_indexed_geometry (
    simplifier: MeshSimplifier,
    source: BufferGeometry,
    target_triangle_count: number
  ): DecimationResult {
    const welded_indices = MeshDecimator.weld_identical_vertices(source)
    const ranges = MeshDecimator.index_ranges(source, welded_indices.length)
    const parts = ranges.map(range => welded_indices.subarray(range.start, range.start + range.count))
    const welded = MeshDecimator.compact_geometry(source, parts, ranges)

    const result = MeshDecimator.decimate_geometry(simplifier, welded.geometry, target_triangle_count)
    welded.geometry.dispose()

    return {
      ...result,
      source_vertex_ids: result.source_vertex_ids.map(id => welded.source_vertex_ids[id]),
      source_triangle_count: welded_indices.length / 3
    }
  }

  /**
   * Builds a new geometry that contains only the vertices the simplified
   * triangles use, in order of first use. Every attribute (and morph target)
   * is copied over, and the material groups are rebuilt.
   */
  public static compact_geometry (
    source: BufferGeometry,
    index_parts: Uint32Array[],
    ranges: Array<{ material_index: number | undefined }>
  ): { geometry: BufferGeometry, source_vertex_ids: Uint32Array } {
    const source_vertex_count = source.attributes.position.count
    const new_id_of = new Int32Array(source_vertex_count).fill(-1)
    const kept: number[] = []

    const total_index_count = index_parts.reduce((sum, part) => sum + part.length, 0)
    const new_indices = new Uint32Array(total_index_count)
    let write = 0
    for (const part of index_parts) {
      for (let i = 0; i < part.length; i++) {
        const source_id = part[i]
        if (new_id_of[source_id] === -1) {
          new_id_of[source_id] = kept.length
          kept.push(source_id)
        }
        new_indices[write++] = new_id_of[source_id]
      }
    }
    const source_vertex_ids = Uint32Array.from(kept)

    const geometry = new BufferGeometry()
    geometry.name = source.name
    geometry.userData = { ...source.userData }

    for (const [name, attribute] of Object.entries(source.attributes)) {
      geometry.setAttribute(name, MeshDecimator.gather_attribute(attribute, source_vertex_ids))
    }
    const morph_attributes = geometry.morphAttributes as Record<string, Array<BufferAttribute | InterleavedBufferAttribute>>
    for (const [name, morph_list] of Object.entries(source.morphAttributes)) {
      morph_attributes[name] = morph_list.map(attribute => MeshDecimator.gather_attribute(attribute, source_vertex_ids))
    }
    geometry.morphTargetsRelative = source.morphTargetsRelative

    geometry.setIndex(new BufferAttribute(kept.length > 65535 ? new_indices : Uint16Array.from(new_indices), 1))

    // rebuild the material groups from the simplified parts
    if (source.groups.length > 0) {
      let start = 0
      index_parts.forEach((part, part_index) => {
        geometry.addGroup(start, part.length, ranges[part_index].material_index)
        start += part.length
      })
    }

    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return { geometry, source_vertex_ids }
  }

  /**
   * Builds an index buffer for a non-indexed geometry by pointing every vertex
   * at the first vertex with exactly the same attributes. Without it, every
   * triangle would be a separate island and nothing could be simplified.
   * The returned indices refer to vertices of the source geometry.
   */
  public static weld_identical_vertices (source: BufferGeometry): Uint32Array {
    const vertex_count = source.attributes.position.count
    const attributes = Object.values(source.attributes)
    const indices = new Uint32Array(vertex_count)

    // hash table of first-seen vertices, chained through next_in_bucket
    let bucket_count = 1
    while (bucket_count < vertex_count * 2) bucket_count *= 2
    const bucket_heads = new Int32Array(bucket_count).fill(-1)
    const next_in_bucket = new Int32Array(vertex_count)
    const float_bits = new Float32Array(1)
    const int_bits = new Int32Array(float_bits.buffer)

    const vertex_hash = (vertex: number): number => {
      let hash = 2166136261
      for (const attribute of attributes) {
        for (let c = 0; c < attribute.itemSize; c++) {
          float_bits[0] = attribute.getComponent(vertex, c)
          hash = Math.imul(hash ^ int_bits[0], 16777619)
        }
      }
      return hash & (bucket_count - 1)
    }

    const same_vertex = (a: number, b: number): boolean => {
      for (const attribute of attributes) {
        for (let c = 0; c < attribute.itemSize; c++) {
          if (attribute.getComponent(a, c) !== attribute.getComponent(b, c)) return false
        }
      }
      return true
    }

    for (let v = 0; v < vertex_count; v++) {
      const bucket = vertex_hash(v)
      let match = -1
      for (let other = bucket_heads[bucket]; other !== -1; other = next_in_bucket[other]) {
        if (same_vertex(v, other)) { match = other; break }
      }
      if (match === -1) {
        next_in_bucket[v] = bucket_heads[bucket]
        bucket_heads[bucket] = v
        match = v
      }
      indices[v] = match
    }
    return indices
  }

  /**
   * The index ranges to simplify separately: one per material group, or the
   * whole index buffer when the geometry has no groups.
   */
  private static index_ranges (source: BufferGeometry, index_count: number): Array<{ start: number, count: number, material_index: number | undefined }> {
    if (source.groups.length === 0) {
      return [{ start: 0, count: index_count, material_index: undefined }]
    }
    return source.groups.map(group => {
      const start = Math.min(group.start, index_count)
      const count = Math.min(group.count, index_count - start)
      return { start, count: count - (count % 3), material_index: group.materialIndex }
    })
  }

  private static tightly_packed_positions (source: BufferGeometry): Float32Array {
    const position = source.attributes.position
    if (position instanceof BufferAttribute && position.array instanceof Float32Array &&
      position.itemSize === 3 && !position.normalized) {
      return position.array
    }
    const packed = new Float32Array(position.count * 3)
    for (let i = 0; i < position.count; i++) {
      packed[i * 3] = position.getX(i)
      packed[i * 3 + 1] = position.getY(i)
      packed[i * 3 + 2] = position.getZ(i)
    }
    return packed
  }

  /**
   * Normals and UVs packed per vertex for the simplifier, so it avoids collapses
   * that would visibly bend the shading or stretch the texture.
   */
  private static similarity_attributes (source: BufferGeometry): { attributes: Float32Array, stride: number, weights: number[] } {
    const normal = source.attributes.normal
    const uv = source.attributes.uv
    const parts: Array<{ attribute: BufferAttribute | InterleavedBufferAttribute, size: number, weight: number }> = []
    if (normal !== undefined) parts.push({ attribute: normal, size: 3, weight: MeshDecimator.normal_weight })
    if (uv !== undefined) parts.push({ attribute: uv, size: 2, weight: MeshDecimator.uv_weight })

    const stride = parts.reduce((sum, part) => sum + part.size, 0)
    const vertex_count = source.attributes.position.count
    const attributes = new Float32Array(vertex_count * stride)
    const weights: number[] = []
    let offset = 0
    for (const part of parts) {
      for (let v = 0; v < vertex_count; v++) {
        for (let c = 0; c < part.size; c++) {
          attributes[v * stride + offset + c] = part.attribute.getComponent(v, c)
        }
      }
      for (let c = 0; c < part.size; c++) weights.push(part.weight)
      offset += part.size
    }
    return { attributes, stride, weights }
  }

  /**
   * Copies the raw stored values (not getComponent(), which would turn
   * normalized integers into floats), so the new attribute keeps the same
   * array type and normalized flag as the source.
   */
  private static gather_attribute (attribute: BufferAttribute | InterleavedBufferAttribute, vertex_ids: Uint32Array): BufferAttribute {
    const item_size = attribute.itemSize
    const is_interleaved = (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute === true
    const source_array = (is_interleaved ? (attribute as InterleavedBufferAttribute).data.array : attribute.array) as TypedArray
    const stride = is_interleaved ? (attribute as InterleavedBufferAttribute).data.stride : item_size
    const offset = is_interleaved ? (attribute as InterleavedBufferAttribute).offset : 0

    const ArrayType = source_array.constructor as new (length: number) => TypedArray
    const gathered = new ArrayType(vertex_ids.length * item_size)
    for (let i = 0; i < vertex_ids.length; i++) {
      const read_start = vertex_ids[i] * stride + offset
      for (let c = 0; c < item_size; c++) {
        gathered[i * item_size + c] = source_array[read_start + c]
      }
    }
    return new BufferAttribute(gathered, item_size, attribute.normalized)
  }
}
