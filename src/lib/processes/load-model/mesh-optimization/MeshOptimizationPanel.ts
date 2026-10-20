import { UI } from '../../../UI.ts'
import { type MeshOptimizationOptions, type MeshOptimizationSummary } from './ModelMeshOptimizer.ts'

/**
 * What the panel needs from the step that owns the loaded model.
 */
export interface OptimizableModel {
  get_triangle_count: () => number
  get_largest_texture_size: () => number
  is_mesh_optimized: () => boolean
  optimize_mesh_for_games: (options: MeshOptimizationOptions) => Promise<MeshOptimizationSummary>
  revert_mesh_optimization: () => void
}

/**
 * The "Optimize for games" controls shown next to the model positioning tools.
 */
export class MeshOptimizationPanel {
  private readonly ui: UI = UI.getInstance()
  private readonly model: OptimizableModel
  private is_working: boolean = false

  constructor (model: OptimizableModel) {
    this.model = model
  }

  public add_event_listeners (): void {
    this.ui.dom_mesh_optimization_apply_button?.addEventListener('click', () => {
      void this.optimize()
    })

    this.ui.dom_mesh_optimization_revert_button?.addEventListener('click', () => {
      this.model.revert_mesh_optimization()
      this.set_result_text('Reverted to the original model.')
      this.refresh()
    })
  }

  /**
   * Updates the counts and button states, e.g. after a new model is loaded.
   */
  public refresh (): void {
    const triangle_count = this.model.get_triangle_count()
    const largest_texture = this.model.get_largest_texture_size()
    const texture_text = largest_texture > 0 ? ` · textures up to ${largest_texture} px` : ''

    if (this.ui.dom_mesh_optimization_stats !== null) {
      this.ui.dom_mesh_optimization_stats.textContent = `${MeshOptimizationPanel.format_count(triangle_count)} triangles${texture_text}`
    }
    if (this.ui.dom_mesh_optimization_revert_button !== null) {
      this.ui.dom_mesh_optimization_revert_button.disabled = this.is_working || !this.model.is_mesh_optimized()
    }
    if (this.ui.dom_mesh_optimization_apply_button !== null) {
      this.ui.dom_mesh_optimization_apply_button.disabled = this.is_working
    }
  }

  /**
   * Called when a new model is loaded, so the result of the previous model does not linger.
   */
  public reset (): void {
    this.set_result_text('')
    this.refresh()
  }

  private async optimize (): Promise<void> {
    if (this.is_working) return
    this.is_working = true
    this.set_result_text('Optimizing...')
    this.refresh()

    // let the browser paint the message before the main thread gets busy. The
    // timer covers background tabs, where animation frames do not fire at all
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0))
      setTimeout(resolve, 100)
    })

    try {
      const summary = await this.model.optimize_mesh_for_games(this.read_options())
      this.set_result_text(MeshOptimizationPanel.describe_summary(summary))
    } catch (error) {
      console.error('Mesh optimization failed', error)
      this.set_result_text('Optimization failed. The model was left as it was.')
    } finally {
      this.is_working = false
      this.refresh()
    }
  }

  private read_options (): MeshOptimizationOptions {
    const parse = (value: string | undefined): number | null => {
      const parsed = Number.parseInt(value ?? '', 10)
      return Number.isFinite(parsed) ? parsed : null
    }
    return {
      target_triangle_count: parse(this.ui.dom_mesh_optimization_target?.value),
      max_texture_size: parse(this.ui.dom_mesh_optimization_texture_size?.value)
    }
  }

  private set_result_text (text: string): void {
    if (this.ui.dom_mesh_optimization_result !== null) {
      this.ui.dom_mesh_optimization_result.textContent = text
    }
  }

  /**
   * One short line per change, for example:
   * "Triangles 1,500,000 → 100,000. Mesh data 72.4 MB → 4.4 MB. Textures 4096 → 2048 px (25% of the pixels)."
   */
  public static describe_summary (summary: MeshOptimizationSummary): string {
    const parts: string[] = [
      `Triangles ${MeshOptimizationPanel.format_count(summary.triangles_before)} → ${MeshOptimizationPanel.format_count(summary.triangles_after)}.`,
      `Mesh data ${MeshOptimizationPanel.format_megabytes(summary.mesh_bytes_before)} → ${MeshOptimizationPanel.format_megabytes(summary.mesh_bytes_after)}.`
    ]
    if (summary.texture_pixels_after < summary.texture_pixels_before) {
      const percent = Math.round(summary.texture_pixels_after / summary.texture_pixels_before * 100)
      parts.push(`Textures ${summary.largest_texture_before} → ${summary.largest_texture_after} px (${percent}% of the pixels).`)
    }
    parts.push(`Took ${(summary.duration_ms / 1000).toFixed(1)} s.`)
    return parts.join(' ')
  }

  private static format_count (count: number): string {
    return count.toLocaleString('en-US')
  }

  private static format_megabytes (bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
}
