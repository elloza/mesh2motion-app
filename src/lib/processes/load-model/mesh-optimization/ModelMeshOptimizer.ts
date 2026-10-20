import { type BufferGeometry, type Material, type Mesh, Matrix4, type Texture, Vector3 } from 'three'
import { MeshDecimator, type MeshSimplifier } from './MeshDecimator.ts'
import { TextureDownscaler } from './TextureDownscaler.ts'

export interface MeshOptimizationOptions {
  // total triangles to keep across all meshes, or null to keep the geometry as is
  target_triangle_count: number | null
  // longest texture side in pixels, or null to keep the textures as they are
  max_texture_size: number | null
}

export interface MeshOptimizationSummary {
  triangles_before: number
  triangles_after: number
  vertices_before: number
  vertices_after: number
  // geometry bytes as they will be exported, including the skinning data added at bind time
  mesh_bytes_before: number
  mesh_bytes_after: number
  largest_texture_before: number
  largest_texture_after: number
  texture_pixels_before: number
  texture_pixels_after: number
  relative_error: number
  duration_ms: number
}

/**
 * The geometry and textures as they were before any optimization, kept so the
 * user can go back to them.
 */
interface OriginalModelData {
  geometries: BufferGeometry[]
  import_positions: Float32Array[]
  // for each mesh, the original vertex each current vertex came from (null = mesh not decimated)
  source_vertex_ids: Array<Uint32Array | null>
  // original texture -> smaller copy the materials currently use
  texture_replacements: Map<Texture, Texture>
}

// skinIndex (4 x uint16) + skinWeight (4 x float32) written per vertex when the mesh is bound
const SKIN_BYTES_PER_VERTEX = 4 * 2 + 4 * 4

/**
 * Optional "make game-ready" pass for very dense models (AI-generated meshes
 * often have more than a million triangles and 4K textures). It works in
 * place on the loaded model's meshes and can be undone: the original geometry
 * and texture images are kept until revert() or forget().
 *
 * The user can still rotate or move the model after optimizing. Those edits
 * change the vertices directly, so before going back to the original geometry
 * the same transform is worked out from the kept vertices and applied to it.
 */
export class ModelMeshOptimizer {
  private original: OriginalModelData | null = null
  private simplifier: MeshSimplifier | null = null

  public is_optimized (): boolean {
    return this.original !== null
  }

  /**
   * Drops the kept original data, e.g. when a different model is loaded.
   */
  public forget (): void {
    this.original = null
  }

  /**
   * Optimizes the meshes in place. Running it again starts from the original
   * data again, so settings can be tried one after another without the loss adding up.
   * @param import_positions vertex positions as imported, used by "Reset position"
   * @returns the import positions matching the optimized meshes
   */
  public async apply (
    meshes: Mesh[],
    import_positions: Float32Array[],
    options: MeshOptimizationOptions
  ): Promise<{ import_positions: Float32Array[], summary: MeshOptimizationSummary }> {
    const start_time = performance.now()
    const materials = meshes.map(mesh => mesh.material as Material | Material[])

    if (this.original !== null) {
      this.restore_original(meshes)
    } else {
      this.original = {
        geometries: meshes.map(mesh => mesh.geometry),
        import_positions,
        source_vertex_ids: meshes.map(() => null),
        texture_replacements: new Map()
      }
    }
    const original = this.original

    const triangles_before = ModelMeshOptimizer.triangle_total(original.geometries)
    const vertices_before = ModelMeshOptimizer.vertex_total(original.geometries)
    const mesh_bytes_before = ModelMeshOptimizer.export_bytes(original.geometries)
    const texture_stats_before = ModelMeshOptimizer.texture_stats(TextureDownscaler.collect_textures(materials))

    let relative_error = 0
    const new_import_positions = [...original.import_positions]

    if (options.target_triangle_count !== null && options.target_triangle_count < triangles_before) {
      this.simplifier ??= await MeshDecimator.load_simplifier()
      const budgets = MeshDecimator.distribute_triangle_budget(
        original.geometries.map(geometry => ModelMeshOptimizer.triangle_count(geometry)),
        options.target_triangle_count
      )

      meshes.forEach((mesh, i) => {
        const source = original.geometries[i]
        if (budgets[i] >= ModelMeshOptimizer.triangle_count(source)) return

        const result = MeshDecimator.decimate_geometry(this.simplifier as MeshSimplifier, source, budgets[i])
        mesh.geometry = result.geometry
        original.source_vertex_ids[i] = result.source_vertex_ids
        new_import_positions[i] = ModelMeshOptimizer.gather_positions(original.import_positions[i], result.source_vertex_ids)
        relative_error = Math.max(relative_error, result.relative_error)
      })
    }

    if (options.max_texture_size !== null) {
      original.texture_replacements = TextureDownscaler.downscale_textures(materials, options.max_texture_size)
    }

    const current_geometries = meshes.map(mesh => mesh.geometry)
    const texture_stats_after = ModelMeshOptimizer.texture_stats(TextureDownscaler.collect_textures(materials))

    return {
      import_positions: new_import_positions,
      summary: {
        triangles_before,
        triangles_after: ModelMeshOptimizer.triangle_total(current_geometries),
        vertices_before,
        vertices_after: ModelMeshOptimizer.vertex_total(current_geometries),
        mesh_bytes_before,
        mesh_bytes_after: ModelMeshOptimizer.export_bytes(current_geometries),
        largest_texture_before: texture_stats_before.largest_side,
        largest_texture_after: texture_stats_after.largest_side,
        texture_pixels_before: texture_stats_before.pixels,
        texture_pixels_after: texture_stats_after.pixels,
        relative_error,
        duration_ms: performance.now() - start_time
      }
    }
  }

  /**
   * Puts the original geometry and textures back.
   * @returns the original import positions, or null if nothing was optimized
   */
  public revert (meshes: Mesh[]): Float32Array[] | null {
    if (this.original === null) return null
    this.restore_original(meshes)
    const import_positions = this.original.import_positions
    this.original = null
    return import_positions
  }

  /**
   * Swaps the original geometry back into the meshes, carrying over any rotation
   * or move the user made since optimizing, and restores the texture images.
   */
  private restore_original (meshes: Mesh[]): void {
    const original = this.original as OriginalModelData
    meshes.forEach((mesh, i) => {
      const source_vertex_ids = original.source_vertex_ids[i]
      if (source_vertex_ids === null) return // this mesh was never replaced

      const original_geometry = original.geometries[i]
      const transform = ModelMeshOptimizer.solve_transform(original_geometry, mesh.geometry, source_vertex_ids)
      if (transform !== null) {
        original_geometry.applyMatrix4(transform)
      }
      mesh.geometry.dispose()
      mesh.geometry = original_geometry
      original.source_vertex_ids[i] = null
    })

    TextureDownscaler.restore(meshes.map(mesh => mesh.material as Material | Material[]), original.texture_replacements)
    original.texture_replacements = new Map()
  }

  /**
   * Finds the rigid transform (rotation, translation and uniform scale) that
   * maps the original vertices onto where their copies are now, using three
   * spread-out vertices plus a fourth point built from their normal.
   * @returns null when nothing moved, or when the mesh is too small to tell
   */
  public static solve_transform (original: BufferGeometry, current: BufferGeometry, source_vertex_ids: Uint32Array): Matrix4 | null {
    const original_positions = original.attributes.position
    const current_positions = current.attributes.position
    const count = source_vertex_ids.length
    if (count < 3) return null

    const original_point = (k: number): Vector3 => new Vector3().fromBufferAttribute(original_positions, source_vertex_ids[k])
    const current_point = (k: number): Vector3 => new Vector3().fromBufferAttribute(current_positions, k)

    // three vertices far apart from each other, so rounding errors do not matter
    const first = 0
    let second = 0
    let best_distance = -1
    const first_point = original_point(first)
    for (let k = 1; k < count; k++) {
      const distance = original_point(k).distanceToSquared(first_point)
      if (distance > best_distance) { best_distance = distance; second = k }
    }
    const axis = original_point(second).sub(first_point)
    let third = 0
    let best_area = -1
    for (let k = 1; k < count; k++) {
      const area = new Vector3().crossVectors(axis, original_point(k).sub(first_point)).lengthSq()
      if (area > best_area) { best_area = area; third = k }
    }
    if (best_distance <= 0 || best_area <= 1e-12) return null

    const frame = (a: Vector3, b: Vector3, c: Vector3): Matrix4 => {
      const u = new Vector3().subVectors(b, a)
      const v = new Vector3().subVectors(c, a)
      const w = new Vector3().crossVectors(u, v).normalize().multiplyScalar(u.length())
      return new Matrix4().set(
        u.x, v.x, w.x, a.x,
        u.y, v.y, w.y, a.y,
        u.z, v.z, w.z, a.z,
        0, 0, 0, 1
      )
    }

    const original_frame = frame(original_point(first), original_point(second), original_point(third))
    const current_frame = frame(current_point(first), current_point(second), current_point(third))
    const transform = current_frame.multiply(original_frame.invert())

    const identity = new Matrix4()
    const max_difference = transform.elements.reduce((max, value, i) => Math.max(max, Math.abs(value - identity.elements[i])), 0)
    return max_difference < 1e-6 ? null : transform
  }

  private static gather_positions (positions: Float32Array, vertex_ids: Uint32Array): Float32Array {
    const gathered = new Float32Array(vertex_ids.length * 3)
    for (let i = 0; i < vertex_ids.length; i++) {
      gathered[i * 3] = positions[vertex_ids[i] * 3]
      gathered[i * 3 + 1] = positions[vertex_ids[i] * 3 + 1]
      gathered[i * 3 + 2] = positions[vertex_ids[i] * 3 + 2]
    }
    return gathered
  }

  public static triangle_count (geometry: BufferGeometry): number {
    return Math.floor((geometry.index?.count ?? geometry.attributes.position.count) / 3)
  }

  private static triangle_total (geometries: BufferGeometry[]): number {
    return geometries.reduce((sum, geometry) => sum + ModelMeshOptimizer.triangle_count(geometry), 0)
  }

  private static vertex_total (geometries: BufferGeometry[]): number {
    return geometries.reduce((sum, geometry) => sum + geometry.attributes.position.count, 0)
  }

  /**
   * Bytes of vertex and index data in an export: every attribute, the index,
   * and the skin weights the bind step adds. Textures are not included.
   */
  public static export_bytes (geometries: BufferGeometry[]): number {
    return geometries.reduce((sum, geometry) => {
      let bytes = (geometry.index?.array.byteLength ?? 0) + geometry.attributes.position.count * SKIN_BYTES_PER_VERTEX
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (name === 'skinIndex' || name === 'skinWeight') continue // already counted above
        bytes += attribute.count * attribute.itemSize * (attribute.array as Float32Array).BYTES_PER_ELEMENT
      }
      return sum + bytes
    }, 0)
  }

  private static texture_stats (textures: Texture[]): { largest_side: number, pixels: number } {
    let largest_side = 0
    let pixels = 0
    textures.forEach((texture) => {
      const { width, height } = TextureDownscaler.image_size(texture.image)
      largest_side = Math.max(largest_side, width, height)
      pixels += width * height
    })
    return { largest_side, pixels }
  }
}
