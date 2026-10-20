import { describe, it, expect, beforeAll } from 'vitest'
import { BufferAttribute, type BufferGeometry, SphereGeometry, TorusKnotGeometry } from 'three'
import { MeshDecimator, type MeshSimplifier } from './MeshDecimator'

let simplifier: MeshSimplifier

beforeAll(async () => {
  simplifier = await MeshDecimator.load_simplifier()
})

function triangle_count (geometry: BufferGeometry): number {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3
}

/**
 * Every vertex of the result must be an exact copy of the source vertex it
 * says it came from, for every attribute. That is what keeps UVs (and so the
 * textures) valid without re-baking.
 */
function expect_vertices_copied_from_source (source: BufferGeometry, result: BufferGeometry, source_vertex_ids: Uint32Array): void {
  for (const [name, attribute] of Object.entries(result.attributes)) {
    const source_attribute = source.attributes[name]
    for (let i = 0; i < source_vertex_ids.length; i++) {
      for (let c = 0; c < attribute.itemSize; c++) {
        expect(attribute.getComponent(i, c)).toBe(source_attribute.getComponent(source_vertex_ids[i], c))
      }
    }
  }
}

describe('MeshDecimator.decimate_geometry', () => {
  it('reduces an indexed mesh to about the target triangle count', () => {
    const source = new TorusKnotGeometry(1, 0.3, 256, 32) // 16,384 triangles
    const result = MeshDecimator.decimate_geometry(simplifier, source, 2000)

    expect(result.source_triangle_count).toBe(triangle_count(source))
    expect(result.triangle_count).toBeLessThanOrEqual(2000)
    expect(result.triangle_count).toBeGreaterThan(1800)
    expect(result.relative_error).toBeGreaterThan(0)
    expect(result.relative_error).toBeLessThan(0.05)
  })

  it('only keeps vertices the new triangles use, copied exactly from the source', () => {
    const source = new SphereGeometry(1, 96, 48)
    const result = MeshDecimator.decimate_geometry(simplifier, source, 1000)

    const vertex_count = result.geometry.attributes.position.count
    expect(result.source_vertex_ids.length).toBe(vertex_count)
    const used = new Set(Array.from(result.geometry.index!.array))
    expect(used.size).toBe(vertex_count)
    expect(Math.max(...used)).toBe(vertex_count - 1)

    expect_vertices_copied_from_source(source, result.geometry, result.source_vertex_ids)
  })

  it('leaves the source geometry untouched', () => {
    const source = new SphereGeometry(1, 64, 32)
    const positions_before = Float32Array.from(source.attributes.position.array)
    const index_before = Uint32Array.from(source.index!.array)

    MeshDecimator.decimate_geometry(simplifier, source, 500)

    expect(source.attributes.position.array).toEqual(positions_before)
    expect(Uint32Array.from(source.index!.array)).toEqual(index_before)
  })

  it('welds a non-indexed mesh first, so it can still be simplified', () => {
    const source = new TorusKnotGeometry(1, 0.3, 128, 16).toNonIndexed()
    expect(source.index).toBeNull()

    const result = MeshDecimator.decimate_geometry(simplifier, source, 500)

    expect(result.triangle_count).toBeLessThanOrEqual(500)
    expect(result.triangle_count).toBeGreaterThan(400)
    expect_vertices_copied_from_source(source, result.geometry, result.source_vertex_ids)
  })

  it('simplifies each material group on its own and keeps the groups', () => {
    const source = new TorusKnotGeometry(1, 0.3, 128, 16) // 4,096 triangles
    const index_count = source.index!.count
    source.clearGroups()
    source.addGroup(0, index_count / 2, 0)
    source.addGroup(index_count / 2, index_count / 2, 1)

    const result = MeshDecimator.decimate_geometry(simplifier, source, 1000)
    const groups = result.geometry.groups

    expect(groups.map(group => group.materialIndex)).toEqual([0, 1])
    expect(groups[0].start).toBe(0)
    expect(groups[1].start).toBe(groups[0].count)
    expect(groups[0].count + groups[1].count).toBe(result.geometry.index!.count)
    // the budget is split by size, so each half gets about half of it
    expect(groups[0].count / 3).toBeLessThanOrEqual(500)
    expect(groups[1].count / 3).toBeLessThanOrEqual(500)
  })

  it('keeps the array type and normalized flag of extra attributes', () => {
    const source = new SphereGeometry(1, 32, 16)
    const vertex_count = source.attributes.position.count
    const colors = new Uint8Array(vertex_count * 4).map((_, i) => (i * 37) % 256)
    source.setAttribute('color', new BufferAttribute(colors, 4, true))

    const result = MeshDecimator.decimate_geometry(simplifier, source, 200)
    const color = result.geometry.attributes.color as BufferAttribute

    expect(color.array).toBeInstanceOf(Uint8Array)
    expect(color.normalized).toBe(true)
    const first_source_vertex = result.source_vertex_ids[0]
    expect(Array.from(color.array.slice(0, 4))).toEqual(Array.from(colors.slice(first_source_vertex * 4, first_source_vertex * 4 + 4)))
  })
})

describe('MeshDecimator.weld_identical_vertices', () => {
  it('points every vertex at the first vertex with exactly the same attributes', () => {
    const source = new SphereGeometry(1, 8, 4).toNonIndexed()
    const indices = MeshDecimator.weld_identical_vertices(source)
    const position = source.attributes.position
    const uv = source.attributes.uv

    for (let v = 0; v < indices.length; v++) {
      const target = indices[v]
      expect(target).toBeLessThanOrEqual(v)
      expect(position.getX(target)).toBe(position.getX(v))
      expect(position.getY(target)).toBe(position.getY(v))
      expect(position.getZ(target)).toBe(position.getZ(v))
      expect(uv.getX(target)).toBe(uv.getX(v))
      expect(uv.getY(target)).toBe(uv.getY(v))
    }
    // vertices shared by neighboring triangles collapse to one
    expect(new Set(indices).size).toBeLessThan(indices.length / 2)
  })
})

describe('MeshDecimator.distribute_triangle_budget', () => {
  it('splits the budget in proportion to each mesh size', () => {
    expect(MeshDecimator.distribute_triangle_budget([900, 100], 500)).toEqual([450, 50])
  })

  it('keeps every triangle when the total already fits', () => {
    expect(MeshDecimator.distribute_triangle_budget([300, 100], 1000)).toEqual([300, 100])
  })

  it('never gives a mesh less than one triangle', () => {
    expect(MeshDecimator.distribute_triangle_budget([100000, 3], 10)).toEqual([9, 1])
  })
})
