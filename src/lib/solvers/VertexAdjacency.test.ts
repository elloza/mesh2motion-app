import { describe, it, expect } from 'vitest'
import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three'
import { VertexAdjacency } from './VertexAdjacency'

/**
 * The Set-per-vertex adjacency the smoother used before VertexAdjacency.
 * Kept here as the reference: neighbor lists must match it in content AND order.
 */
function reference_adjacency (geometry: BufferGeometry): number[][] {
  const vertex_count = geometry.attributes.position.array.length / 3
  const adjacency: Array<Set<number>> = Array.from({ length: vertex_count }, () => new Set<number>())
  const indices = geometry.index?.array ?? []
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]; const b = indices[i + 1]; const c = indices[i + 2]
    adjacency[a].add(b); adjacency[a].add(c)
    adjacency[b].add(a); adjacency[b].add(c)
    adjacency[c].add(a); adjacency[c].add(b)
  }
  return adjacency.map(neighbors => [...neighbors])
}

function seeded_random (seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function indexed_geometry (vertex_count: number, indices: number[]): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(vertex_count * 3), 3))
  geometry.setIndex(new Uint32BufferAttribute(indices, 1))
  return geometry
}

function all_neighbors (adjacency: VertexAdjacency, vertex_count: number): number[][] {
  return Array.from({ length: vertex_count }, (_, v) => adjacency.get_neighbors(v))
}

describe('VertexAdjacency.from_geometry', () => {
  it('links the vertices of each triangle edge without duplicates', () => {
    // two triangles sharing the 1-2 edge: 0-1-2 and 2-1-3
    const geometry = indexed_geometry(4, [0, 1, 2, 2, 1, 3])
    const adjacency = VertexAdjacency.from_geometry(geometry)

    expect(adjacency.get_neighbors(0)).toEqual([1, 2])
    expect(adjacency.get_neighbors(1)).toEqual([0, 2, 3])
    expect(adjacency.get_neighbors(2)).toEqual([0, 1, 3])
    expect(adjacency.get_neighbors(3)).toEqual([2, 1])
  })

  it('iterates neighbors through neighbor_start/neighbor_end', () => {
    const geometry = indexed_geometry(4, [0, 1, 2, 2, 1, 3])
    const adjacency = VertexAdjacency.from_geometry(geometry)

    const neighbors_of_1: number[] = []
    for (let k = adjacency.neighbor_start(1); k < adjacency.neighbor_end(1); k++) {
      neighbors_of_1.push(adjacency.neighbors[k])
    }
    expect(neighbors_of_1).toEqual([0, 2, 3])
  })

  it('gives no neighbors when the geometry has no index', () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(9), 3))
    const adjacency = VertexAdjacency.from_geometry(geometry)

    expect(all_neighbors(adjacency, 3)).toEqual([[], [], []])
  })

  it('gives isolated vertices no neighbors', () => {
    const geometry = indexed_geometry(5, [0, 1, 2])
    const adjacency = VertexAdjacency.from_geometry(geometry)

    expect(adjacency.get_neighbors(3)).toEqual([])
    expect(adjacency.get_neighbors(4)).toEqual([])
  })

  it('matches the Set-based adjacency, including neighbor order, on a random dense mesh', () => {
    const random = seeded_random(42)
    const vertex_count = 2000
    const indices: number[] = []
    // random triangles over a small vertex pool so most vertices are shared by many
    // triangles and repeat edges, plus some degenerate triangles that repeat a vertex
    for (let t = 0; t < 12000; t++) {
      const a = Math.floor(random() * vertex_count)
      const b = Math.floor(random() * vertex_count)
      const c = random() < 0.02 ? a : Math.floor(random() * vertex_count)
      indices.push(a, b, c)
    }
    const geometry = indexed_geometry(vertex_count, indices)

    const adjacency = VertexAdjacency.from_geometry(geometry)

    expect(all_neighbors(adjacency, vertex_count)).toEqual(reference_adjacency(geometry))
  })
})
