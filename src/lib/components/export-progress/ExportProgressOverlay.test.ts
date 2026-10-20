import { describe, it, expect, afterEach } from 'vitest'
import { ExportProgressOverlay } from './ExportProgressOverlay'

describe('ExportProgressOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.body.removeAttribute('aria-busy')
  })

  it('shows one accessible overlay with the message and removes it when hidden', () => {
    const overlay = new ExportProgressOverlay()
    overlay.show('Generating the engine pack…')
    overlay.show('Generating the engine pack…') // showing twice does not stack overlays

    const elements = document.querySelectorAll('.export-progress-overlay')
    expect(elements).toHaveLength(1)
    expect(elements[0].getAttribute('role')).toBe('status')
    expect(elements[0].textContent).toBe('Generating the engine pack…')
    expect(document.body.getAttribute('aria-busy')).toBe('true')
    expect(overlay.is_visible()).toBe(true)

    overlay.hide()
    expect(document.querySelector('.export-progress-overlay')).toBeNull()
    expect(document.body.hasAttribute('aria-busy')).toBe(false)
    expect(overlay.is_visible()).toBe(false)
  })

  it('waits for the next paint before resolving', async () => {
    let resolved = false
    const waiting = ExportProgressOverlay.wait_until_painted().then(() => { resolved = true })
    expect(resolved).toBe(false)
    await waiting
    expect(resolved).toBe(true)
  })
})
