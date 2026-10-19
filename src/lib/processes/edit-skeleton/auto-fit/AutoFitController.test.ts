import { describe, it, expect } from 'vitest'
import { Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { AutoFitController, RIGGED_MODEL_WARNING, type AutoFitStateChangedDetail } from './AutoFitController'
import {
  AutoFitAbortedError,
  DEFAULT_AUTO_FIT_OPTIONS,
  type AutoFitOptions,
  type AutoFitResult,
  type GeometrySnapshot,
  type JointEstimator
} from './AutoFitTypes'
import { build_synthetic_humanoid } from './test-fixtures/SyntheticHumanoid'

/** Estimator whose answer the test decides, to control timing */
class ControlledEstimator implements JointEstimator {
  public calls: Array<{ signal?: AbortSignal, resolve: (result: AutoFitResult) => void, reject: (error: unknown) => void }> = []

  public async estimate (_input: GeometrySnapshot, _options: AutoFitOptions, signal?: AbortSignal): Promise<AutoFitResult> {
    return await new Promise<AutoFitResult>((resolve, reject) => {
      this.calls.push({ signal, resolve, reject })
    })
  }
}

const empty_snapshot = (): GeometrySnapshot => ({
  points: new Float32Array(0), point_count: 0, bounds_min: [0, 0, 0], bounds_max: [0, 0, 0], source_mesh_count: 0, source_triangle_count: 0
})

function fake_result (label: string, status: AutoFitResult['status'] = 'success'): AutoFitResult {
  return { status, pose: 't-pose', joints: [], warnings: [], diagnostics: { label } }
}

// wait until the controller reached the estimator (after its first yield)
async function until_estimating (estimator: ControlledEstimator, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && estimator.calls.length < count; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(estimator.calls.length).toBe(count)
}

function record_states (controller: AutoFitController): string[] {
  const states: string[] = []
  controller.addEventListener('auto-fit-state-changed', (event) => {
    const detail = (event as CustomEvent<AutoFitStateChangedDetail>).detail
    states.push(detail.phase === null ? detail.state : `${detail.state}:${detail.phase}`)
  })
  return states
}

describe('AutoFitController', () => {
  it('goes idle -> analyzing -> preview with the real estimator, then applied', async () => {
    const controller = new AutoFitController()
    const states = record_states(controller)

    const result = await controller.run(build_synthetic_humanoid({ arm_angle_degrees: 45 }).root)

    expect(result?.status).toBe('success')
    expect(states).toEqual(['analyzing:analyzing-geometry', 'analyzing:fitting-skeleton', 'preview'])
    expect(controller.can_apply()).toBe(true)

    controller.mark_applied()
    expect(controller.state()).toBe('applied')
    expect(controller.can_apply()).toBe(false)
  })

  it('ends in unsupported for a model that is not a humanoid, which cannot be applied', async () => {
    const controller = new AutoFitController()
    await controller.run(new Mesh(new SphereGeometry(1, 32, 16), new MeshBasicMaterial()))

    expect(controller.state()).toBe('unsupported')
    expect(controller.can_apply()).toBe(false)
    controller.mark_applied()
    expect(controller.state()).toBe('unsupported')
  })

  it('reports failures and allows trying again', async () => {
    let should_fail = true
    const controller = new AutoFitController(undefined, () => {
      if (should_fail) { throw new Error('broken geometry') }
      return empty_snapshot()
    })

    expect(await controller.run(build_synthetic_humanoid().root)).toBeNull()
    expect(controller.state()).toBe('failed')
    expect(controller.error_message()).toBe('broken geometry')

    should_fail = false
    await controller.run(build_synthetic_humanoid().root)
    expect(controller.state()).toBe('unsupported') // empty snapshot, but the retry ran normally
    expect(controller.error_message()).toBeNull()
  })

  it('cancels a running analysis, aborts the estimator and ignores its late result', async () => {
    const estimator = new ControlledEstimator()
    const controller = new AutoFitController(estimator, empty_snapshot)

    const pending = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 1)
    expect(controller.is_running()).toBe(true)

    controller.cancel()
    expect(estimator.calls[0].signal?.aborted).toBe(true)
    expect(controller.state()).toBe('idle')

    estimator.calls[0].resolve(fake_result('late'))
    expect(await pending).toBeNull()
    expect(controller.state()).toBe('idle')
    expect(controller.result()).toBeNull()
  })

  it('treats an aborted estimator as a return to idle, not a failure', async () => {
    const estimator = new ControlledEstimator()
    const controller = new AutoFitController(estimator, empty_snapshot)
    const pending = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 1)

    estimator.calls[0].reject(new AutoFitAbortedError())
    expect(await pending).toBeNull()
    expect(controller.state()).toBe('idle')
  })

  it('only keeps the result of the latest run', async () => {
    const estimator = new ControlledEstimator()
    const controller = new AutoFitController(estimator, empty_snapshot)

    const first = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 1)
    const second = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 2)

    expect(estimator.calls[0].signal?.aborted).toBe(true)
    estimator.calls[1].resolve(fake_result('second'))
    expect((await second)?.diagnostics.label).toBe('second')

    // the first run finishing afterwards must not overwrite anything
    estimator.calls[0].resolve(fake_result('first'))
    expect(await first).toBeNull()
    expect(controller.result()?.diagnostics.label).toBe('second')
    expect(controller.state()).toBe('preview')
  })

  it('reset while analyzing discards the run (e.g. leaving the step or loading another model)', async () => {
    const estimator = new ControlledEstimator()
    const controller = new AutoFitController(estimator, empty_snapshot)
    const pending = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 1)

    controller.reset()
    estimator.calls[0].resolve(fake_result('stale'))

    expect(await pending).toBeNull()
    expect(controller.state()).toBe('idle')
    expect(controller.result()).toBeNull()
  })

  it('discard drops the proposal without applying it', async () => {
    const estimator = new ControlledEstimator()
    const controller = new AutoFitController(estimator, empty_snapshot)
    const pending = controller.run(build_synthetic_humanoid().root)
    await until_estimating(estimator, 1)
    estimator.calls[0].resolve(fake_result('proposal', 'partial'))
    await pending
    expect(controller.can_apply()).toBe(true) // partial results can be applied after review

    controller.discard()
    expect(controller.state()).toBe('idle')
    expect(controller.result()).toBeNull()
  })

  it('warns when the uploaded model already had a skeleton', async () => {
    const controller = new AutoFitController()
    const result = await controller.run(build_synthetic_humanoid().root, DEFAULT_AUTO_FIT_OPTIONS, { model_was_rigged: true })

    expect(result?.warnings[0]).toBe(RIGGED_MODEL_WARNING)
  })
})
