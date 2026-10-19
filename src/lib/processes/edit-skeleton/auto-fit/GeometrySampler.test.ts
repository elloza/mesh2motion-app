import { describe, it, expect } from 'vitest'
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three'
import { GeometrySampler } from './GeometrySampler'

const material = new MeshBasicMaterial()

describe('GeometrySampler', () => {
  it('returns the requested number of points and is deterministic for the same seed', () => {
    const mesh = new Mesh(new BoxGeometry(1, 2, 1), material)
    const first = GeometrySampler.sample(mesh, 2000, 7)
    const second = GeometrySampler.sample(mesh, 2000, 7)

    expect(first.point_count).toBe(2000)
    expect(first.points.length).toBe(6000)
    expect(Array.from(first.points)).toEqual(Array.from(second.points))
  })

  it('samples in world space using the full parent transform chain', () => {
    const group = new Group()
    group.position.set(5, 1, -2)
    group.scale.setScalar(10)
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material)
    mesh.position.set(0, 0.5, 0) // box from y = 0 to 1 in group space
    group.add(mesh)

    const snapshot = GeometrySampler.sample(group, 1000)

    expect(snapshot.bounds_min[0]).toBeCloseTo(0, 5)
    expect(snapshot.bounds_max[0]).toBeCloseTo(10, 5)
    expect(snapshot.bounds_min[1]).toBeCloseTo(1, 5)
    expect(snapshot.bounds_max[1]).toBeCloseTo(11, 5)
    expect(snapshot.bounds_min[2]).toBeCloseTo(-7, 5)
    expect(snapshot.bounds_max[2]).toBeCloseTo(3, 5)

    for (let i = 0; i < snapshot.point_count; i++) {
      expect(snapshot.points[i * 3]).toBeGreaterThanOrEqual(-1e-4)
      expect(snapshot.points[i * 3]).toBeLessThanOrEqual(10 + 1e-4)
    }
  })

  it('distributes samples by surface area across several meshes', () => {
    const group = new Group()
    const big_plane = new Mesh(new PlaneGeometry(2, 2), material) // area 4
    const small_plane = new Mesh(new PlaneGeometry(1, 1), material) // area 1
    small_plane.position.set(10, 0, 0)
    group.add(big_plane, small_plane)

    const snapshot = GeometrySampler.sample(group, 10000)
    let small_count = 0
    for (let i = 0; i < snapshot.point_count; i++) {
      if (snapshot.points[i * 3] > 5) { small_count++ }
    }

    expect(snapshot.source_mesh_count).toBe(2)
    expect(small_count / snapshot.point_count).toBeGreaterThan(0.17)
    expect(small_count / snapshot.point_count).toBeLessThan(0.23)
  })

  it('does not modify the source geometry or transforms', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), material)
    mesh.position.set(1, 2, 3)
    const positions_before = Array.from(mesh.geometry.getAttribute('position').array)
    const uvs_before = Array.from(mesh.geometry.getAttribute('uv').array)

    GeometrySampler.sample(mesh, 500)

    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(positions_before)
    expect(Array.from(mesh.geometry.getAttribute('uv').array)).toEqual(uvs_before)
    expect(mesh.position.toArray()).toEqual([1, 2, 3])
  })

  it('returns an empty snapshot when there is no usable surface', () => {
    expect(GeometrySampler.sample(new Group(), 100).point_count).toBe(0)

    // two degenerate triangles: collinear points and NaN values
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0, 1, 1, 1, 2, 2, 2,
      NaN, 0, 0, 1, 0, 0, 0, 1, 0
    ], 3))
    const snapshot = GeometrySampler.sample(new Mesh(geometry, material), 100)

    expect(snapshot.point_count).toBe(0)
    expect(snapshot.points.length).toBe(0)
    expect(snapshot.source_triangle_count).toBe(2)
  })

  it('ignores degenerate triangles but keeps sampling valid ones', () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute([
      NaN, 0, 0, 1, 0, 0, 0, 1, 0, // invalid
      0, 0, 0, 1, 0, 0, 0, 1, 0 // valid
    ], 3))
    const snapshot = GeometrySampler.sample(new Mesh(geometry, material), 300)

    expect(snapshot.point_count).toBe(300)
    for (let i = 0; i < snapshot.points.length; i++) {
      expect(Number.isFinite(snapshot.points[i])).toBe(true)
    }
  })
})
