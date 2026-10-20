import { describe, it, expect, vi, afterEach } from 'vitest'
import { Mesh, MeshStandardMaterial, Texture, TorusKnotGeometry, type BufferGeometry } from 'three'
import { ModelMeshOptimizer } from './ModelMeshOptimizer'
import { TextureDownscaler } from './TextureDownscaler'

function build_mesh (): Mesh {
  return new Mesh(new TorusKnotGeometry(1, 0.3, 128, 16), new MeshStandardMaterial()) // 4,096 triangles
}

function positions_of (geometry: BufferGeometry): Float32Array {
  return Float32Array.from(geometry.attributes.position.array)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ModelMeshOptimizer', () => {
  it('replaces the mesh geometry and reports the reduction', async () => {
    const mesh = build_mesh()
    const original_geometry = mesh.geometry
    const optimizer = new ModelMeshOptimizer()

    const { import_positions, summary } = await optimizer.apply([mesh], [positions_of(mesh.geometry)], {
      target_triangle_count: 1000,
      max_texture_size: null
    })

    expect(mesh.geometry).not.toBe(original_geometry)
    expect(optimizer.is_optimized()).toBe(true)
    expect(summary.triangles_before).toBe(4096)
    expect(summary.triangles_after).toBeLessThanOrEqual(1000)
    expect(summary.vertices_after).toBe(mesh.geometry.attributes.position.count)
    expect(summary.mesh_bytes_after).toBeLessThan(summary.mesh_bytes_before)
    // the "Reset position" snapshot has to match the new vertex list
    expect(import_positions[0].length).toBe(mesh.geometry.attributes.position.count * 3)
  })

  it('reverts to the original geometry and import positions', async () => {
    const mesh = build_mesh()
    const original_geometry = mesh.geometry
    const original_import_positions = positions_of(mesh.geometry)
    const optimizer = new ModelMeshOptimizer()

    await optimizer.apply([mesh], [original_import_positions], { target_triangle_count: 1000, max_texture_size: null })
    const restored_positions = optimizer.revert([mesh])

    expect(mesh.geometry).toBe(original_geometry)
    expect(restored_positions?.[0]).toBe(original_import_positions)
    expect(optimizer.is_optimized()).toBe(false)
    expect(optimizer.revert([mesh])).toBeNull()
  })

  it('carries rotations and moves made after optimizing over to the original on revert', async () => {
    const mesh = build_mesh()
    const original_geometry = mesh.geometry
    const optimizer = new ModelMeshOptimizer()
    await optimizer.apply([mesh], [positions_of(mesh.geometry)], { target_triangle_count: 1000, max_texture_size: null })

    // what the rotate and auto-align buttons do to the visible geometry
    mesh.geometry.rotateX(Math.PI / 2)
    mesh.geometry.rotateY(Math.PI / 2)
    mesh.geometry.translate(0.25, 1.5, -0.4)
    const expected = new TorusKnotGeometry(1, 0.3, 128, 16)
    expected.rotateX(Math.PI / 2)
    expected.rotateY(Math.PI / 2)
    expected.translate(0.25, 1.5, -0.4)

    optimizer.revert([mesh])

    expect(mesh.geometry).toBe(original_geometry)
    const actual = mesh.geometry.attributes.position.array
    const wanted = expected.attributes.position.array
    for (let i = 0; i < wanted.length; i++) {
      expect(actual[i]).toBeCloseTo(wanted[i], 4)
    }
  })

  it('starts from the original each time it is applied again', async () => {
    const mesh = build_mesh()
    const optimizer = new ModelMeshOptimizer()

    await optimizer.apply([mesh], [positions_of(mesh.geometry)], { target_triangle_count: 500, max_texture_size: null })
    const { summary } = await optimizer.apply([mesh], [positions_of(mesh.geometry)], { target_triangle_count: 2000, max_texture_size: null })

    expect(summary.triangles_before).toBe(4096)
    expect(summary.triangles_after).toBeGreaterThan(1800)
  })

  it('leaves meshes alone when the target is not below their triangle count', async () => {
    const mesh = build_mesh()
    const original_geometry = mesh.geometry
    const optimizer = new ModelMeshOptimizer()

    const { summary } = await optimizer.apply([mesh], [positions_of(mesh.geometry)], { target_triangle_count: 100000, max_texture_size: null })

    expect(mesh.geometry).toBe(original_geometry)
    expect(summary.triangles_after).toBe(4096)
  })

  it('downscales the textures and puts the original textures back on revert', async () => {
    const draw_image = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw_image } as unknown as CanvasRenderingContext2D)

    const mesh = build_mesh()
    const material = mesh.material as MeshStandardMaterial
    const original_image = { width: 4096, height: 4096 }
    const texture = new Texture(original_image as unknown as HTMLImageElement)
    material.map = texture
    const optimizer = new ModelMeshOptimizer()

    const { summary } = await optimizer.apply([mesh], [positions_of(mesh.geometry)], { target_triangle_count: null, max_texture_size: 1024 })

    expect(material.map).not.toBe(texture)
    expect(TextureDownscaler.image_size(material.map.image)).toEqual({ width: 1024, height: 1024 })
    expect(texture.image).toBe(original_image) // the original is left as it was
    expect(summary.largest_texture_before).toBe(4096)
    expect(summary.largest_texture_after).toBe(1024)
    expect(draw_image).toHaveBeenCalled()

    optimizer.revert([mesh])
    expect(material.map).toBe(texture)
  })
})

describe('ModelMeshOptimizer.solve_transform', () => {
  it('returns null when the vertices have not moved', () => {
    const geometry = new TorusKnotGeometry(1, 0.3, 32, 8)
    const ids = Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i)

    expect(ModelMeshOptimizer.solve_transform(geometry, geometry.clone(), ids)).toBeNull()
  })
})
