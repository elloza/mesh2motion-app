import { type Object3D } from 'three'
import {
  AutoFitAbortedError,
  DEFAULT_AUTO_FIT_OPTIONS,
  type AutoFitOptions,
  type AutoFitResult,
  type GeometrySnapshot,
  type JointEstimator
} from './AutoFitTypes.ts'
import { GeometrySampler } from './GeometrySampler.ts'
import { HumanJointEstimator } from './HumanJointEstimator.ts'

/**
 * idle        nothing proposed, Auto Fit can be started
 * analyzing   working, can be cancelled
 * preview     a proposal is ready, nothing has been applied yet
 * applied     the proposal was applied to the skeleton (undo is available)
 * unsupported the model could not be fitted, nothing was changed
 * failed      something went wrong, nothing was changed, can retry
 */
export type AutoFitState = 'idle' | 'analyzing' | 'preview' | 'applied' | 'unsupported' | 'failed'
export type AutoFitPhase = 'analyzing-geometry' | 'fitting-skeleton'

export interface AutoFitRunContext {
  // the uploaded file already had a skinned mesh / skeleton
  model_was_rigged?: boolean
}

export interface AutoFitStateChangedDetail {
  state: AutoFitState
  phase: AutoFitPhase | null
}

export const RIGGED_MODEL_WARNING: string = 'This model already had a skeleton. Auto Fit places the Mesh2Motion human rig instead. To keep the original rig, use "Use Your Rigged Model".'

/*
 * AutoFitController
 * Runs an estimator for the Auto Fit Skeleton feature and keeps track of its
 * state. It does not touch the DOM or the skeleton: StepEditSkeleton listens
 * to 'auto-fit-state-changed' and applies the result when the user confirms.
 *
 * Only the latest run counts. Starting again, cancelling or resetting makes any
 * older run that is still finishing be ignored.
 */
export class AutoFitController extends EventTarget {
  private current_state: AutoFitState = 'idle'
  private current_phase: AutoFitPhase | null = null
  private current_result: AutoFitResult | null = null
  private current_error_message: string | null = null
  private run_counter: number = 0
  private abort_controller: AbortController | null = null

  constructor (
    private readonly estimator: JointEstimator = new HumanJointEstimator(),
    private readonly sample_geometry: (model_root: Object3D) => GeometrySnapshot = (model_root) => GeometrySampler.sample(model_root)
  ) {
    super()
  }

  public state (): AutoFitState {
    return this.current_state
  }

  public phase (): AutoFitPhase | null {
    return this.current_phase
  }

  public result (): AutoFitResult | null {
    return this.current_result
  }

  public error_message (): string | null {
    return this.current_error_message
  }

  public is_running (): boolean {
    return this.current_state === 'analyzing'
  }

  /**
   * Partial results can be applied too (the user sees the warnings first),
   * unsupported ones never.
   */
  public can_apply (): boolean {
    return this.current_state === 'preview' && this.current_result !== null && this.current_result.status !== 'unsupported'
  }

  /**
   * Analyze the model and produce a proposal. Resolves with the result, or null
   * if this run was cancelled, replaced by a newer run, or failed.
   */
  public async run (model_root: Object3D, options: AutoFitOptions = DEFAULT_AUTO_FIT_OPTIONS, context: AutoFitRunContext = {}): Promise<AutoFitResult | null> {
    this.abort_running()
    const run_id = ++this.run_counter
    const abort_controller = new AbortController()
    this.abort_controller = abort_controller
    this.current_result = null
    this.current_error_message = null
    const is_current = (): boolean => run_id === this.run_counter

    this.set_state('analyzing', 'analyzing-geometry')

    try {
      // let the UI show the progress state before the synchronous sampling
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (abort_controller.signal.aborted) { throw new AutoFitAbortedError() }

      const snapshot = this.sample_geometry(model_root)
      if (!is_current()) { return null }

      this.set_state('analyzing', 'fitting-skeleton')
      const result = await this.estimator.estimate(snapshot, options, abort_controller.signal)
      if (!is_current()) { return null }

      if (context.model_was_rigged === true && result.status !== 'unsupported') {
        result.warnings.unshift(RIGGED_MODEL_WARNING)
      }

      this.current_result = result
      this.set_state(result.status === 'unsupported' ? 'unsupported' : 'preview')
      return result
    } catch (error) {
      if (!is_current()) { return null }
      if (error instanceof AutoFitAbortedError) {
        this.set_state('idle')
        return null
      }
      console.error('Auto Fit failed', error)
      this.current_error_message = error instanceof Error ? error.message : String(error)
      this.set_state('failed')
      return null
    } finally {
      if (this.abort_controller === abort_controller) {
        this.abort_controller = null
      }
    }
  }

  /**
   * Stop the running analysis. Its result will be ignored even if it still arrives.
   */
  public cancel (): void {
    if (this.current_state !== 'analyzing') { return }
    this.abort_running()
    this.run_counter++
    this.set_state('idle')
  }

  /**
   * Throw away the current proposal (or error) without applying it
   */
  public discard (): void {
    if (this.current_state === 'analyzing') {
      this.cancel()
      return
    }
    this.current_result = null
    this.current_error_message = null
    this.set_state('idle')
  }

  /**
   * Called by the editor once the proposal has been applied to the skeleton
   */
  public mark_applied (): void {
    if (this.can_apply()) {
      this.set_state('applied')
    }
  }

  /**
   * Forget everything, e.g. when leaving the step or loading another model
   */
  public reset (): void {
    this.abort_running()
    this.run_counter++
    this.current_result = null
    this.current_error_message = null
    this.set_state('idle')
  }

  private abort_running (): void {
    this.abort_controller?.abort()
    this.abort_controller = null
  }

  private set_state (state: AutoFitState, phase: AutoFitPhase | null = null): void {
    this.current_state = state
    this.current_phase = phase
    const detail: AutoFitStateChangedDetail = { state, phase }
    this.dispatchEvent(new CustomEvent('auto-fit-state-changed', { detail }))
  }
}
