import { describe, it, expect } from 'vitest'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { SharedPositionLookup } from './SharedPositionLookup'

/**
 * The string-keyed position map the smoother used before SharedPositionLookup.
 * Kept here as the reference: the same vertices must count as "shared".
 */
function reference_shared_vertices (geometry: BufferGeometry): number[][] {
  const position = geometry.attributes.position
  const vertex_count = position.array.length / 3
  const key_of = (i: number): string =>
    `${position.getX(i).toFixed(6)},${position.getY(i).toFixed(6)},${position.getZ(i).toFixed(6)}`

  const position_to_indices = new Map<string, number[]>()
  for (let i = 0; i < vertex_count; i++) {
    const key = key_of(i)
    if (!position_to_indices.has(key)) position_to_indices.set(key, [])
    position_to_indices.get(key)!.push(i)
  }
  return Array.from({ length: vertex_count }, (_, i) => position_to_indices.get(key_of(i))!)
}

function lookup_all (geometry: BufferGeometry): number[][] {
  const lookup = new SharedPositionLookup(geometry)
  const vertex_count = geometry.attributes.position.array.length / 3
  return Array.from({ length: vertex_count }, (_, i) => lookup.get_shared_vertices(i))
}

function geometry_from_points (points: Array<[number, number, number]>): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3))
  return geometry
}

function seeded_random (seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

describe('SharedPositionLookup.get_shared_vertices', () => {
  it('groups vertices split at the same position (UV seams)', () => {
    const geometry = geometry_from_points([
      [0.1, 0.2, 0.3],
      [0.5, 0.5, 0.5],
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3]
    ])
    const lookup = new SharedPositionLookup(geometry)

    expect(lookup.get_shared_vertices(2)).toEqual([0, 2, 3])
    expect(lookup.get_shared_vertices(1)).toEqual([1])
  })

  it('returns the same cached list for every vertex of a group', () => {
    const geometry = geometry_from_points([[1, 1, 1], [1, 1, 1]])
    const lookup = new SharedPositionLookup(geometry)

    expect(lookup.get_shared_vertices(0)).toBe(lookup.get_shared_vertices(1))
  })

  it('treats positions that round to the same 6 decimals as shared, even across hash cells', () => {
    // 0.4999996 and 0.5000004 both print as 0.500000 but fall on either side
    // of the hash cell boundary at x = 0.5, so the neighbor-cell search must find them
    const geometry = geometry_from_points([
      [0.4999996, 0.25, 0.25],
      [0.5000004, 0.25, 0.25],
      [0.5000012, 0.25, 0.25] // prints as 0.500001, not shared
    ])

    expect(lookup_all(geometry)).toEqual(reference_shared_vertices(geometry))
    expect(lookup_all(geometry)[0]).toEqual([0, 1])
    expect(lookup_all(geometry)[2]).toEqual([2])
  })

  it('keeps -0.000000 and 0.000000 apart, like the string keys did', () => {
    const geometry = geometry_from_points([
      [-0.0000001, 0, 0],
      [0.0000001, 0, 0],
      [0, 0, 0]
    ])

    expect(lookup_all(geometry)).toEqual(reference_shared_vertices(geometry))
  })

  it('matches the string-keyed map on a random dense point set with seams and near-duplicates', () => {
    const random = seeded_random(7)
    const points: Array<[number, number, number]> = []
    for (let i = 0; i < 20000; i++) {
      const roll = random()
      if (roll < 0.15 && points.length > 0) {
        // exact duplicate, like a UV seam split
        points.push([...points[Math.floor(random() * points.length)]])
      } else if (roll < 0.25 && points.length > 0) {
        // nudged by up to ~2e-6, so some round to the same 6 decimals and some do not
        const [x, y, z] = points[Math.floor(random() * points.length)]
        const nudge = (): number => (random() - 0.5) * 4e-6
        points.push([x + nudge(), y + nudge(), z + nudge()])
      } else {
        points.push([random() * 2 - 1, random() * 2, random() * 0.6 - 0.3])
      }
    }
    const geometry = geometry_from_points(points)

    expect(lookup_all(geometry)).toEqual(reference_shared_vertices(geometry))
  })
})
