import { describe, it, expect } from 'vitest'
import { Bone, BufferGeometry, Float32BufferAttribute, Vector3 } from 'three'
import { Utility } from '../Utilities'
import { SkeletonType } from '../enums/SkeletonType'
import { WeightCalculator } from './WeightCalculator'

/**
 * Minimal humanoid rig. The hip bone is named hips_pelvis so both the human
 * (pelvis) and fox (hips) rig configs find their position tracking bone. World positions:
 *   root (0, 0, 0)
 *   hips_pelvis (0, 1.0, 0) -> spine (0, 1.3, 0) -> head (0, 1.7, 0) -> head_leaf (0, 1.9, 0)
 *   hips_pelvis -> thigh_l (+0.15, 0.9, 0) -> calf_l (+0.15, 0.5, 0) -> foot_l (+0.15, 0.1, 0)
 *   hips_pelvis -> thigh_r (-0.15, 0.9, 0) -> calf_r (-0.15, 0.5, 0) -> foot_r (-0.15, 0.1, 0)
 * root (global transform only) and head_leaf (orientation only) never get vertices.
 */
function build_test_rig (): Bone[] {
  const make = (name: string, x: number, y: number, parent?: Bone): Bone => {
    const bone = new Bone()
    bone.name = name
    bone.position.set(x, y, 0)
    parent?.add(bone)
    return bone
  }

  const root = make('root', 0, 0)
  const pelvis = make('hips_pelvis', 0, 1.0, root)
  const spine = make('spine', 0, 0.3, pelvis)
  const head = make('head', 0, 0.4, spine)
  make('head_leaf', 0, 0.2, head)

  const thigh_l = make('thigh_l', 0.15, -0.1, pelvis)
  const calf_l = make('calf_l', 0, -0.4, thigh_l)
  make('foot_l', 0, -0.4, calf_l)

  const thigh_r = make('thigh_r', -0.15, -0.1, pelvis)
  const calf_r = make('calf_r', 0, -0.4, thigh_r)
  make('foot_r', 0, -0.4, calf_r)

  root.updateWorldMatrix(true, true)
  return Utility.bone_list_from_hierarchy(root)
}

function bone_index (bones: Bone[], name: string): number {
  return bones.findIndex(bone => bone.name === name)
}

/**
 * Non-indexed geometry: the given points, followed by a floor triangle under the
 * pelvis that the hip raycast in initialize_caches() hits.
 */
function geometry_with_floor (points: Array<[number, number, number]>): BufferGeometry {
  const floor: Array<[number, number, number]> = [[-1, 0.6, -1], [1, 0.6, -1], [0, 0.6, 1]]
  const all_points = [...points]
  while (all_points.length % 3 !== 0) all_points.push(points[0]) // keep whole triangles
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute([...all_points, ...floor].flat(), 3))
  return geometry
}

/**
 * The per-bone loop calculate_median_bone_weights() used before it was flattened
 * into typed arrays. Kept here as the reference the fast version must match exactly.
 */
function reference_closest_bones (bones: Bone[], geometry: BufferGeometry, skeleton_type: SkeletonType, hips_cutoff: number): number[] {
  const midpoints = bones.map(bone => Utility.bone_midpoint_to_child(bone))
  const vertex_count = geometry.attributes.position.array.length / 3
  const result: number[] = []

  for (let i = 0; i < vertex_count; i++) {
    const vertex_position = new Vector3().fromBufferAttribute(geometry.attributes.position, i)
    let closest_bone_distance = 1000
    let closest_bone_index = 0

    bones.forEach((bone, idx) => {
      if (bone.name === 'root' || Utility.is_leaf_bone(bone)) return
      if (skeleton_type === SkeletonType.Human &&
        (bone.name.includes('hips') || bone.name.includes('pelvis')) &&
        hips_cutoff < vertex_position.y) {
        return
      }
      const distance = midpoints[idx].distanceTo(vertex_position)
      if (distance < closest_bone_distance) {
        closest_bone_distance = distance
        closest_bone_index = idx
      }
    })
    result.push(closest_bone_index)
  }
  return result
}

function seeded_random (seed: number): () => number {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

function run_calculator (bones: Bone[], geometry: BufferGeometry, skeleton_type: SkeletonType): { calculator: WeightCalculator, skin_indices: number[], skin_weights: number[] } {
  const calculator = new WeightCalculator(bones, geometry, skeleton_type)
  calculator.initialize_caches()
  const skin_indices: number[] = []
  const skin_weights: number[] = []
  calculator.calculate_median_bone_weights(skin_indices, skin_weights)
  return { calculator, skin_indices, skin_weights }
}

// the cutoff is private; the reference needs the exact same value to compare against
function hips_cutoff_of (calculator: WeightCalculator): number {
  return (calculator as unknown as { distance_to_bottom_of_position_tracking_bone: number }).distance_to_bottom_of_position_tracking_bone
}

describe('WeightCalculator.calculate_median_bone_weights', () => {
  it('assigns each vertex fully to the bone with the closest midpoint', () => {
    const bones = build_test_rig()
    // thigh_l midpoint is (0.15, 0.7, 0), spine midpoint is (0, 1.5, 0)
    const geometry = geometry_with_floor([[0.2, 0.7, 0], [0, 1.5, 0.05], [0.2, 0.7, 0]])

    const { skin_indices, skin_weights } = run_calculator(bones, geometry, SkeletonType.Human)

    expect(skin_indices.slice(0, 4)).toEqual([bone_index(bones, 'thigh_l'), 0, 0, 0])
    expect(skin_indices.slice(4, 8)).toEqual([bone_index(bones, 'spine'), 0, 0, 0])
    expect(skin_weights.slice(0, 4)).toEqual([1.0, 0, 0, 0])
  })

  it('never assigns vertices to the root or leaf bones', () => {
    const bones = build_test_rig()
    // right on top of head_leaf (0, 1.9, 0) and the root (0, 0, 0)
    const geometry = geometry_with_floor([[0, 1.9, 0], [0, 0, 0], [0, 1.9, 0]])

    const { skin_indices } = run_calculator(bones, geometry, SkeletonType.Human)

    expect(skin_indices[0]).toBe(bone_index(bones, 'head'))
    expect(skin_indices[4]).not.toBe(bone_index(bones, 'root'))
  })

  it('gives an exact distance tie to the earlier bone', () => {
    const bones = build_test_rig()
    // x = 0 is exactly halfway between the left and right thigh midpoints
    const geometry = geometry_with_floor([[0, 0.7, 0], [0, 0.7, 0], [0, 0.7, 0]])

    const { skin_indices } = run_calculator(bones, geometry, SkeletonType.Human)

    expect(bone_index(bones, 'thigh_l')).toBeLessThan(bone_index(bones, 'thigh_r'))
    expect(skin_indices[0]).toBe(bone_index(bones, 'thigh_l'))
  })

  it('falls back to bone 0 for vertices 1000+ units from every bone', () => {
    const bones = build_test_rig()
    const geometry = geometry_with_floor([[5000, 0, 0], [5000, 0, 0], [5000, 0, 0]])

    const { skin_indices } = run_calculator(bones, geometry, SkeletonType.Human)

    expect(skin_indices[0]).toBe(0)
  })

  it('skips the hip bone for vertices above the hips cutoff on human rigs only', () => {
    const bones = build_test_rig()
    // right on the pelvis midpoint (0, 1.15, 0), well above the cutoff (~0.6)
    const geometry = geometry_with_floor([[0, 1.15, 0], [0, 1.15, 0], [0, 1.15, 0]])

    const human = run_calculator(bones, geometry, SkeletonType.Human)
    expect(human.skin_indices[0]).not.toBe(bone_index(bones, 'hips_pelvis'))

    const fox = run_calculator(bones, geometry, SkeletonType.Fox)
    expect(fox.skin_indices[0]).toBe(bone_index(bones, 'hips_pelvis'))
  })

  it('matches the original per-bone loop exactly on a dense random point cloud', () => {
    const bones = build_test_rig()
    const random = seeded_random(1234)
    const points: Array<[number, number, number]> = []
    for (let i = 0; i < 30000; i++) {
      points.push([random() * 1.2 - 0.6, random() * 2.2 - 0.1, random() * 0.6 - 0.3])
    }
    // exact ties between mirrored bones
    for (let i = 0; i < 300; i++) {
      points.push([0, random() * 2, random() * 0.2 - 0.1])
    }

    for (const skeleton_type of [SkeletonType.Human, SkeletonType.Fox]) {
      const geometry = geometry_with_floor(points)
      const { calculator, skin_indices, skin_weights } = run_calculator(bones, geometry, skeleton_type)

      const expected = reference_closest_bones(bones, geometry, skeleton_type, hips_cutoff_of(calculator))
      const primary_bones = skin_indices.filter((_, i) => i % 4 === 0)
      expect(primary_bones).toEqual(expected)
      expect(skin_weights.every((weight, i) => weight === (i % 4 === 0 ? 1.0 : 0))).toBe(true)
    }
  })
})
