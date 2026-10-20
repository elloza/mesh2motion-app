import { describe, it, expect, beforeEach } from 'vitest'
import { Scene } from 'three'
import { AutoFitPanel, REVIEW_REMINDER, type AutoFitPanelElements } from './AutoFitPanel'
import { AutoFitPreview } from './AutoFitPreview'
import { HUMAN_JOINT_IDS, type AutoFitResult } from './AutoFitTypes'

function build_elements (): AutoFitPanelElements {
  document.body.innerHTML = `
    <div id="container" style="display: none;">
      <button id="run"></button><button id="cancel" hidden></button>
      <p id="status"></p><ul id="warnings"></ul>
      <div id="review" hidden><button id="apply"></button><button id="discard"></button></div>
      <select id="pose"><option value="auto">Auto</option><option value="a-pose">A</option><option value="t-pose">T</option></select>
      <select id="facing"><option value="auto">Auto</option><option value="front">Front</option><option value="back">Back</option></select>
      <input type="checkbox" id="symmetry" checked />
    </div>`
  const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  return {
    container: get('container'),
    run_button: get('run'),
    cancel_button: get('cancel'),
    status: get('status'),
    warnings: get('warnings') as HTMLUListElement,
    review_actions: get('review'),
    apply_button: get('apply'),
    discard_button: get('discard'),
    pose_select: get('pose'),
    facing_select: get('facing'),
    symmetry_checkbox: get('symmetry')
  }
}

function result (status: AutoFitResult['status'], warnings: string[] = []): AutoFitResult {
  return {
    status,
    pose: 'a-pose',
    joints: HUMAN_JOINT_IDS.map((id, index) => ({ id, world_position: [index, index, 0], confidence: index < 5 ? 0.3 : 0.9, method: 'measured' as const, warnings: [] })),
    warnings,
    diagnostics: {}
  }
}

describe('AutoFitPanel', () => {
  let elements: AutoFitPanelElements
  let panel: AutoFitPanel

  beforeEach(() => {
    elements = build_elements()
    panel = new AutoFitPanel(elements)
  })

  it('reads the options from the form', () => {
    expect(panel.options()).toEqual({ pose_mode: 'auto', facing: 'auto', use_symmetry: true })
    ;(elements.pose_select as HTMLSelectElement).value = 't-pose'
    ;(elements.facing_select as HTMLSelectElement).value = 'front'
    ;(elements.symmetry_checkbox as HTMLInputElement).checked = false
    expect(panel.options()).toEqual({ pose_mode: 't-pose', facing: 'front', use_symmetry: false })
  })

  it('wires each button once, even if listeners are added again', () => {
    const calls: string[] = []
    const actions = {
      on_run: () => calls.push('run'),
      on_cancel: () => calls.push('cancel'),
      on_apply: () => calls.push('apply'),
      on_discard: () => calls.push('discard')
    }
    panel.add_event_listeners(actions)
    panel.add_event_listeners(actions)

    elements.run_button?.click()
    elements.apply_button?.click()
    elements.discard_button?.click()
    elements.cancel_button?.click()
    expect(calls).toEqual(['run', 'apply', 'discard', 'cancel'])
  })

  it('shows progress and allows cancelling while analyzing', () => {
    panel.render('analyzing', 'fitting-skeleton', null, null)

    expect(elements.run_button?.disabled).toBe(true)
    expect(elements.cancel_button?.hidden).toBe(false)
    expect(elements.review_actions?.hidden).toBe(true)
    expect(elements.status?.textContent).toBe('Fitting skeleton…')
  })

  it('shows confidence counts, warnings and the review buttons for a preview', () => {
    panel.render('preview', null, result('partial', ['Right wrist may be inaccurate.', 'Right wrist may be inaccurate.']), null)

    expect(elements.review_actions?.hidden).toBe(false)
    expect(elements.apply_button?.textContent).toBe('Apply anyway')
    expect(elements.status?.textContent).toContain(`${HUMAN_JOINT_IDS.length - 5} high`)
    expect(elements.status?.textContent).toContain('5 low')
    expect(elements.status?.textContent).toContain(REVIEW_REMINDER)
    expect(elements.warnings?.children.length).toBe(1) // duplicates removed
  })

  it('explains why a model is unsupported and hides the review buttons', () => {
    panel.render('unsupported', null, result('unsupported', ['The model seems to face backwards.']), null)

    expect(elements.review_actions?.hidden).toBe(true)
    expect(elements.status?.textContent).toContain('The model seems to face backwards.')
    expect(elements.status?.textContent).toContain('Nothing was changed')
  })

  it('reports failures without suggesting anything was changed', () => {
    panel.render('failed', null, null, 'boom')
    expect(elements.status?.textContent).toContain('Auto Fit failed: boom')
    expect(elements.status?.textContent).toContain('Nothing was changed')
  })

  it('can be hidden for non human rigs', () => {
    panel.set_visible(true)
    expect(elements.container?.style.display).toBe('flex')
    panel.set_visible(false)
    expect(elements.container?.style.display).toBe('none')
  })
})

describe('AutoFitPreview', () => {
  it('adds one marker per joint to the scene and removes it again', () => {
    const scene = new Scene()
    const preview = new AutoFitPreview()

    preview.show(scene, result('success'))
    const group = scene.getObjectByName('Auto Fit Preview')
    expect(group).toBeDefined()
    expect(preview.is_visible()).toBe(true)

    // showing again replaces the previous preview instead of stacking them
    preview.show(scene, result('success'))
    expect(scene.children.filter(child => child.name === 'Auto Fit Preview')).toHaveLength(1)

    preview.clear()
    expect(scene.getObjectByName('Auto Fit Preview')).toBeUndefined()
    expect(preview.is_visible()).toBe(false)
  })
})
