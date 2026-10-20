import { type BufferGeometry } from 'three'

/**
 * Which vertices share a triangle edge with each vertex, built from the geometry's index.
 *
 * Stored as flat typed arrays (one neighbor list per vertex, packed back to back)
 * rather than one Set per vertex. On dense meshes (800k+ vertices) a Set per vertex
 * costs hundreds of milliseconds and well over 100 MB of heap.
 *
 * Each vertex's neighbors are kept in the order they are first seen while walking
 * the triangles, which is the same order a Set would iterate them in. The smoother
 * depends on that order, so keeping it keeps the skin weights unchanged.
 *
 * Usage:
 *   for (let k = adjacency.neighbor_start(v); k < adjacency.neighbor_end(v); k++) {
 *     const neighbor = adjacency.neighbors[k]
 *   }
 */
export class VertexAdjacency {
  public readonly neighbors: Int32Array
  private readonly list_starts: Int32Array
  private readonly list_lengths: Int32Array

  private constructor (neighbors: Int32Array, list_starts: Int32Array, list_lengths: Int32Array) {
    this.neighbors = neighbors
    this.list_starts = list_starts
    this.list_lengths = list_lengths
  }

  /**
   * Geometry without an index has no shared edges, so every vertex ends up with no neighbors.
   */
  public static from_geometry (geometry: BufferGeometry): VertexAdjacency {
    const vertex_count = geometry.attributes.position.array.length / 3
    const list_starts = new Int32Array(vertex_count + 1)
    const list_lengths = new Int32Array(vertex_count)

    const index_attribute = geometry.index
    if (index_attribute === null) {
      return new VertexAdjacency(new Int32Array(0), list_starts, list_lengths)
    }
    const indices = index_attribute.array

    // Every triangle corner gives its vertex at most 2 new neighbors, so reserve
    // that much room per vertex and pack each vertex's list into its own slice.
    for (let i = 0; i < indices.length; i++) {
      list_starts[indices[i] + 1] += 2
    }
    for (let v = 0; v < vertex_count; v++) {
      list_starts[v + 1] += list_starts[v]
    }
    const neighbors = new Int32Array(list_starts[vertex_count])

    const add_neighbor = (vertex: number, neighbor: number): void => {
      const start = list_starts[vertex]
      const end = start + list_lengths[vertex]
      // lists are short (about 6 on a typical mesh), so a linear scan is the fastest duplicate check
      for (let k = start; k < end; k++) {
        if (neighbors[k] === neighbor) return
      }
      neighbors[end] = neighbor
      list_lengths[vertex]++
    }

    // same insertion order as the original Set-based adjacency
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]; const b = indices[i + 1]; const c = indices[i + 2]
      add_neighbor(a, b); add_neighbor(a, c)
      add_neighbor(b, a); add_neighbor(b, c)
      add_neighbor(c, a); add_neighbor(c, b)
    }

    return new VertexAdjacency(neighbors, list_starts, list_lengths)
  }

  public neighbor_start (vertex: number): number {
    return this.list_starts[vertex]
  }

  public neighbor_end (vertex: number): number {
    return this.list_starts[vertex] + this.list_lengths[vertex]
  }

  public get_neighbors (vertex: number): number[] {
    return Array.from(this.neighbors.subarray(this.neighbor_start(vertex), this.neighbor_end(vertex)))
  }
}
