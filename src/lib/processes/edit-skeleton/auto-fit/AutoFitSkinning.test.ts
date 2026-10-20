import { describe, it, expect } from 'vitest'
import { Vector3, type Bone, type BufferGeometry, type Mesh, type Object3D } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { WeightCalculator } from '../../../solvers/WeightCalculator'
import { HeadWeightCorrector } from '../../../solvers/HeadWeightCorrector'
import { SkeletonType } from '../../../enums/SkeletonType'
import { GeometrySampler } from './GeometrySampler'
import { HumanJointEstimator } from './HumanJointEstimator'
import { JointPoseApplicator } from './JointPoseApplicator'
import { build_synthetic_humanoid, CHIBI_PROPORTIONS, type SyntheticHumanoidOptions } from './test-fixtures/SyntheticHumanoid'
import { load_human_rig_skeleton } from './test-fixtures/HumanRigLoader'

/**
 * End to end: Auto Fit the real rig to a model, then run the first pass of the
 * existing Mesh2Motion skinning (closest bone midpoint) and look at which bone
 * each part of the body ends up with. Joint positions only matter through
 * this, so it is the check that catches a face split from the head or a palm
 * weighted to the forearm.
 */
async function fit_and_skin (options: SyntheticHumanoidOptions): Promise<{ geometry: BufferGeometry, bones: Bone[], skin_indices: number[], skin_weights: number[], bone_of_vertex: (i: number) => string, height: number }> {
  const humanoid = build_synthetic_humanoid(options)
  const result = await new HumanJointEstimator().estimate(GeometrySampler.sample(humanoid.root))
  expect(result.status).toBe('success')

  const { armature, skeleton } = await load_human_rig_skeleton()
  const applicator = new JointPoseApplicator()
  applicator.apply(skeleton, applicator.plan(skeleton, result))
  armature.updateWorldMatrix(true, true)

  // one world space geometry, like the app after it bakes transforms on import
  const parts: BufferGeometry[] = []
  humanoid.root.traverse((object: Object3D) => {
    const mesh = object as Mesh
    if (mesh.isMesh === true) {
      const part = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
      parts.push(part.index !== null ? part.toNonIndexed() : part)
    }
  })
  const geometry = mergeGeometries(parts.map((part) => {
    // keep only positions so all parts share the same attributes
    Object.keys(part.attributes).filter(name => name !== 'position').forEach(name => part.deleteAttribute(name))
    return part
  }))

  const skin_indices: number[] = []
  const skin_weights: number[] = []
  const calculator = new WeightCalculator(skeleton.bones, geometry, SkeletonType.Human)
  calculator.initialize_caches()
  calculator.calculate_median_bone_weights(skin_indices, skin_weights)

  return {
    geometry,
    bones: skeleton.bones,
    skin_indices,
    skin_weights,
    bone_of_vertex: (i: number) => skeleton.bones[skin_indices[i * 4]].name,
    height: humanoid.height
  }
}

function share_of (geometry: BufferGeometry, bone_of_vertex: (i: number) => string, select: (position: Vector3) => boolean, accept: (bone_name: string) => boolean): number {
  const position = new Vector3()
  let selected = 0
  let accepted = 0
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    position.fromBufferAttribute(geometry.attributes.position, i)
    if (!select(position)) { continue }
    selected++
    if (accept(bone_of_vertex(i))) { accepted++ }
  }
  expect(selected).toBeGreaterThan(0)
  return accepted / selected
}

describe('Auto Fit + existing skinning', () => {
  it('suggests Head Weight Correction for a chibi head, and the suggested plane keeps the arms off the head', async () => {
    const options: SyntheticHumanoidOptions = { proportions: CHIBI_PROPORTIONS }
    const result = await new HumanJointEstimator().estimate(GeometrySampler.sample(build_synthetic_humanoid(options).root))
    const plane_height = result.diagnostics.suggested_head_correction_height as number
    expect(result.warnings.join(' ')).toMatch(/Use Head Weight Correction/)
    expect(plane_height).toBeGreaterThan(0)

    const { geometry, skin_indices, skin_weights, bones, height } = await fit_and_skin(options)
    const head_bottom = height - 2 * CHIBI_PROPORTIONS.head_radius * height
    // HeadWeightCorrector handles arm bones (not clavicles), so that is what is checked here
    const on_arms = (): number => share_of(geometry, i => bones[skin_indices[i * 4]].name, position => position.y > head_bottom + 0.005 * height,
      name => /upperarm|lowerarm|hand/.test(name))

    // without the correction the arms grab part of the big head (existing limitation)
    expect(on_arms()).toBeGreaterThan(0)

    new HeadWeightCorrector(geometry, bones, plane_height).apply_head_weight_correction(skin_indices, skin_weights)
    expect(on_arms()).toBe(0)
  })

  it.each([
    ['adult T-pose', {}],
    ['adult A-pose', { arm_angle_degrees: 45 }]
  ] as Array<[string, SyntheticHumanoidOptions]>)('%s: the whole head goes to the head bone and the hands never to the forearm', async (_name, options) => {
    const { geometry, bone_of_vertex, height } = await fit_and_skin(options)
    const proportions = options.proportions
    const head_radius = (proportions?.head_radius ?? 0.07) * height
    const head_bottom = height - 2 * head_radius

    // every vertex of the head sphere, chin included
    const head_share = share_of(geometry, bone_of_vertex, position => position.y > head_bottom + 0.005 * height, name => name === 'head')
    expect(head_share).toBeGreaterThan(0.98)

    // vertices beyond the wrist, along the arm, belong to the hand or the fingers
    const wrist_x = 0.12 * height // conservative: any vertex past this point on the hand side
    const hand_share = share_of(geometry, bone_of_vertex,
      position => Math.abs(position.x) > wrist_x && position.y > height * 0.3 && is_hand_region(position, options, height),
      name => !name.startsWith('lowerarm'))
    expect(hand_share).toBeGreaterThan(0.95)
  })
})

// hand box of the synthetic humanoid: from the wrist to the finger tips
function is_hand_region (position: Vector3, options: SyntheticHumanoidOptions, height: number): boolean {
  const p = options.proportions
  const shoulder_x = (p?.shoulder_x ?? 0.12) * height
  const shoulder_y = (p?.shoulder ?? 0.8) * height
  const angle = (options.arm_angle_degrees ?? 0) * Math.PI / 180
  const along = (Math.abs(position.x) - shoulder_x) * Math.cos(angle) + (shoulder_y - position.y) * Math.sin(angle)
  const wrist_along = ((p?.upper_arm_length ?? 0.17) + (p?.forearm_length ?? 0.15)) * height
  // a small margin past the wrist so the forearm's own end does not count
  return along > wrist_along + 0.01 * height
}
