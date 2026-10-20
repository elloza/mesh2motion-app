import {
  confidence_level,
  DEFAULT_AUTO_FIT_OPTIONS,
  type AutoFitOptions,
  type AutoFitResult,
  type ConfidenceLevel,
  type DetectedPose,
  type FacingMode,
  type PoseMode
} from './AutoFitTypes.ts'
import { type AutoFitPhase, type AutoFitState } from './AutoFitController.ts'

export interface AutoFitPanelElements {
  container: HTMLElement | null
  run_button: HTMLButtonElement | null
  cancel_button: HTMLButtonElement | null
  status: HTMLElement | null
  warnings: HTMLUListElement | null
  review_actions: HTMLElement | null
  apply_button: HTMLButtonElement | null
  discard_button: HTMLButtonElement | null
  pose_select: HTMLSelectElement | null
  facing_select: HTMLSelectElement | null
  symmetry_checkbox: HTMLInputElement | null
}

export interface AutoFitPanelActions {
  on_run: () => void
  on_cancel: () => void
  on_apply: () => void
  on_discard: () => void
}

export const REVIEW_REMINDER: string = 'Auto Fit estimates joint positions. Review shoulders, elbows, knees and wrists before exporting.'
const MAX_LISTED_WARNINGS = 6

const POSE_LABELS: Record<DetectedPose, string> = {
  'a-pose': 'A-pose',
  't-pose': 'T-pose',
  unknown: 'pose not recognized'
}

/*
 * AutoFitPanel
 * DOM side of Auto Fit Skeleton in the Position Joints step: reads the options
 * and shows the state of the AutoFitController. No fitting logic in here.
 */
export class AutoFitPanel {
  private added_event_listeners: boolean = false

  constructor (private readonly elements: AutoFitPanelElements) {}

  public set_visible (is_visible: boolean): void {
    if (this.elements.container !== null) {
      this.elements.container.style.display = is_visible ? 'flex' : 'none'
    }
  }

  public add_event_listeners (actions: AutoFitPanelActions): void {
    if (this.added_event_listeners) { return }
    this.added_event_listeners = true

    this.elements.run_button?.addEventListener('click', () => { actions.on_run() })
    this.elements.cancel_button?.addEventListener('click', () => { actions.on_cancel() })
    this.elements.apply_button?.addEventListener('click', () => { actions.on_apply() })
    this.elements.discard_button?.addEventListener('click', () => { actions.on_discard() })
  }

  public options (): AutoFitOptions {
    const pose = this.elements.pose_select?.value
    const facing = this.elements.facing_select?.value
    return {
      pose_mode: pose === 'a-pose' || pose === 't-pose' ? pose as PoseMode : DEFAULT_AUTO_FIT_OPTIONS.pose_mode,
      facing: facing === 'front' || facing === 'back' ? facing as FacingMode : DEFAULT_AUTO_FIT_OPTIONS.facing,
      use_symmetry: this.elements.symmetry_checkbox?.checked ?? DEFAULT_AUTO_FIT_OPTIONS.use_symmetry
    }
  }

  public render (state: AutoFitState, phase: AutoFitPhase | null, result: AutoFitResult | null, error_message: string | null): void {
    const is_running = state === 'analyzing'
    const can_review = state === 'preview' && result !== null

    if (this.elements.run_button !== null) {
      this.elements.run_button.disabled = is_running
      this.elements.run_button.textContent = state === 'applied' || state === 'preview' ? 'Run Auto Fit again' : 'Auto Fit Skeleton'
    }
    if (this.elements.cancel_button !== null) {
      this.elements.cancel_button.hidden = !is_running
    }
    if (this.elements.review_actions !== null) {
      this.elements.review_actions.hidden = !can_review
    }
    if (this.elements.apply_button !== null) {
      this.elements.apply_button.textContent = result?.status === 'partial' ? 'Apply anyway' : 'Apply'
    }
    this.elements.container?.setAttribute('aria-busy', is_running ? 'true' : 'false')

    switch (state) {
      case 'idle':
        this.set_status([])
        this.set_warnings([])
        break
      case 'analyzing':
        this.set_status([phase === 'fitting-skeleton' ? 'Fitting skeleton…' : 'Analyzing geometry…'])
        this.set_warnings([])
        break
      case 'preview':
        this.render_preview(result)
        break
      case 'applied':
        this.set_status(['Auto Fit applied. Use Undo to revert it.', REVIEW_REMINDER])
        this.set_warnings(result?.warnings ?? [])
        break
      case 'unsupported': {
        const [reason, ...other_warnings] = result?.warnings ?? []
        this.set_status([`Auto Fit cannot fit this model: ${reason ?? 'unknown reason'}`, 'Nothing was changed. You can still place the joints manually.'])
        this.set_warnings(other_warnings)
        break
      }
      case 'failed':
        this.set_status([`Auto Fit failed: ${error_message ?? 'unknown error'}`, 'Nothing was changed. You can try again or place the joints manually.'])
        this.set_warnings([])
        break
    }
  }

  private render_preview (result: AutoFitResult | null): void {
    if (this.elements.status === null || result === null) { return }

    const counts: Record<ConfidenceLevel, number> = { high: 0, medium: 0, low: 0 }
    result.joints.forEach((joint) => { counts[confidence_level(joint.confidence)]++ })

    const status = this.elements.status
    status.replaceChildren()
    status.append(result.status === 'partial'
      ? 'Partial fit, some joints could not be measured.'
      : `Proposal ready (${POSE_LABELS[result.pose]}).`, document.createElement('br'), 'Confidence:')
    ;(['high', 'medium', 'low'] as ConfidenceLevel[]).forEach((level) => {
      const swatch = document.createElement('span')
      swatch.className = `auto-fit-confidence auto-fit-confidence-${level}`
      swatch.setAttribute('aria-hidden', 'true')
      status.append(swatch, `${counts[level]} ${level}`)
    })
    status.append(document.createElement('br'), REVIEW_REMINDER)

    this.set_warnings(result.warnings)
  }

  private set_status (lines: string[]): void {
    const status = this.elements.status
    if (status === null) { return }
    status.replaceChildren()
    lines.forEach((line, index) => {
      if (index > 0) { status.append(document.createElement('br')) }
      status.append(line)
    })
  }

  private set_warnings (warnings: string[]): void {
    const list = this.elements.warnings
    if (list === null) { return }
    list.replaceChildren()

    const unique = [...new Set(warnings)]
    unique.slice(0, MAX_LISTED_WARNINGS).forEach((warning) => {
      const item = document.createElement('li')
      item.textContent = warning
      list.append(item)
    })
    if (unique.length > MAX_LISTED_WARNINGS) {
      const item = document.createElement('li')
      item.textContent = `…and ${unique.length - MAX_LISTED_WARNINGS} more`
      list.append(item)
    }
  }
}
