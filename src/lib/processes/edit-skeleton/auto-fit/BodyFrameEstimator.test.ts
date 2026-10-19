import { describe, it, expect } from 'vitest'
import { Euler, Matrix4, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3 } from 'three'
import { BodyFrameEstimator } from './BodyFrameEstimator'
import { GeometrySampler } from './GeometrySampler'
import { DEFAULT_AUTO_FIT_OPTIONS } from './AutoFitTypes'
import { build_synthetic_humanoid } from './test-fixtures/SyntheticHumanoid'

function transform (position: Vector3, rotation: Euler, scale: number): Matrix4 {
  return new Matrix4().compose(position, new Quaternion().setFromEuler(rotation), new Vector3(scale, scale, scale))
}

describe('BodyFrameEstimator', () => {
  it('measures floor, height and centre line of a standing humanoid', () => {
    const humanoid = build_synthetic_humanoid()
    const result = BodyFrameEstimator.estimate(GeometrySampler.sample(humanoid.root), DEFAULT_AUTO_FIT_OPTIONS)

    expect(result.unsupported_reason).toBeNull()
    expect(result.frame?.floor_y).toBeCloseTo(0, 2)
    expect(result.frame?.height).toBeCloseTo(1.8, 2)
    expect(result.frame?.center_x).toBeCloseTo(0, 2)
    expect(result.frame?.facing).toBe('front')
  })

  it('follows scale and translation of the model', () => {
    const humanoid = build_synthetic_humanoid({ root_transform: transform(new Vector3(4, 2, -3), new Euler(), 100) })
    const frame = BodyFrameEstimator.estimate(GeometrySampler.sample(humanoid.root), DEFAULT_AUTO_FIT_OPTIONS).frame

    expect(frame).not.toBeNull()
    expect(frame?.floor_y).toBeCloseTo(2, 0)
    expect(frame?.height).toBeCloseTo(180, 0)
    expect(Math.abs((frame?.center_x ?? 0) - 4)).toBeLessThan(0.5)
    expect(frame?.facing).toBe('front')
  })

  it('refuses a model that faces backwards, unless the user says it faces front', () => {
    const humanoid = build_synthetic_humanoid({ root_transform: transform(new Vector3(), new Euler(0, Math.PI, 0), 1) })
    const snapshot = GeometrySampler.sample(humanoid.root)

    const auto = BodyFrameEstimator.estimate(snapshot, DEFAULT_AUTO_FIT_OPTIONS)
    expect(auto.frame).toBeNull()
    expect(auto.unsupported_reason).toMatch(/backwards/)

    const forced = BodyFrameEstimator.estimate(snapshot, { ...DEFAULT_AUTO_FIT_OPTIONS, facing: 'front' })
    expect(forced.frame).not.toBeNull()
  })

  it('refuses models that are not standing upright', () => {
    const lying_down = build_synthetic_humanoid({ root_transform: transform(new Vector3(), new Euler(Math.PI / 2, 0, 0), 1) })
    expect(BodyFrameEstimator.estimate(GeometrySampler.sample(lying_down.root), DEFAULT_AUTO_FIT_OPTIONS).frame).toBeNull()

    const sphere = new Mesh(new SphereGeometry(1), new MeshBasicMaterial())
    expect(BodyFrameEstimator.estimate(GeometrySampler.sample(sphere), DEFAULT_AUTO_FIT_OPTIONS).frame).toBeNull()
  })

  it('refuses empty or tiny inputs', () => {
    const empty = { points: new Float32Array(0), point_count: 0, bounds_min: [0, 0, 0] as [number, number, number], bounds_max: [0, 0, 0] as [number, number, number], source_mesh_count: 0, source_triangle_count: 0 }
    expect(BodyFrameEstimator.estimate(empty, DEFAULT_AUTO_FIT_OPTIONS).unsupported_reason).not.toBeNull()
  })
})
