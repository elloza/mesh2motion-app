/*
 * ExportProgressOverlay
 * Full screen "working" overlay shown while a download is generated. Building
 * FBX files blocks the page for a few seconds, so the overlay is painted first
 * (see wait_until_painted) and the spinner is a compositor animation, which
 * keeps turning while the page is busy.
 */
export class ExportProgressOverlay {
  private overlay: HTMLElement | null = null

  public show (message: string): void {
    if (this.overlay === null) {
      this.overlay = document.createElement('div')
      this.overlay.className = 'export-progress-overlay'
      this.overlay.setAttribute('role', 'status')
      this.overlay.setAttribute('aria-live', 'polite')

      const panel = document.createElement('div')
      panel.className = 'export-progress-panel'
      const spinner = document.createElement('div')
      spinner.className = 'export-progress-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      const text = document.createElement('p')
      text.className = 'export-progress-text'
      panel.append(spinner, text)
      this.overlay.append(panel)
      document.body.append(this.overlay)
    }

    const text = this.overlay.querySelector('.export-progress-text')
    if (text !== null) {
      text.textContent = message
    }
    document.body.setAttribute('aria-busy', 'true')
  }

  public hide (): void {
    this.overlay?.remove()
    this.overlay = null
    document.body.removeAttribute('aria-busy')
  }

  public is_visible (): boolean {
    return this.overlay !== null
  }

  /**
   * Resolves after the browser had the chance to paint the overlay, so it is on
   * screen before a long synchronous export starts
   */
  public static async wait_until_painted (): Promise<void> {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { resolve() })
      })
    })
  }
}
