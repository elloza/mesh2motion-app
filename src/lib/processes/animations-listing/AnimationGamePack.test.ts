import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AnimationClip } from 'three'
import { AnimationGamePack, game_pack_clip_names_by_skeleton } from './AnimationGamePack'
import { AnimationSearch } from './AnimationSearch'
import { SkeletonType } from '../../enums/SkeletonType'
import { type ThemeManager } from '../../ThemeManager'
import { type TransformedAnimationClipPair } from './interfaces/TransformedAnimationClipPair'

// Real clip names (in listing order) around the human game pack clips,
// plus look-alikes that must NOT be picked up by exact matching.
const human_listing_names: string[] = [
  'Death_A', 'Death_B', 'Idle Hurt', 'Idle_A', 'Idle_Talking', 'Jog', 'Jump_2',
  'Jump_Land', 'Jump_Start', 'Jump_air', 'Run_Female', 'Sprint', 'Walk', 'Walk_Formal'
]

describe('AnimationGamePack pack definition', () => {
  it('defines the 7 human game clips', () => {
    expect(AnimationGamePack.get_clip_names(SkeletonType.Human)).toEqual([
      'Idle_A', 'Walk', 'Jog', 'Jump_Start', 'Jump_air', 'Jump_Land', 'Death_A'
    ])
  })

  it('is only available for the human skeleton', () => {
    expect(AnimationGamePack.is_available_for(SkeletonType.Human)).toBe(true)
    expect(AnimationGamePack.is_available_for(SkeletonType.Fox)).toBe(false)
    expect(AnimationGamePack.get_clip_names(SkeletonType.Fox)).toEqual([])
  })

  it('has no duplicate clip names', () => {
    const clip_names = game_pack_clip_names_by_skeleton[SkeletonType.Human] ?? []
    expect(new Set(clip_names).size).toBe(clip_names.length)
  })
})

describe('AnimationGamePack.resolve_selection', () => {
  it('selects exactly the pack clips by exact name', () => {
    const pack_clip_names = AnimationGamePack.get_clip_names(SkeletonType.Human)
    const selection = AnimationGamePack.resolve_selection(human_listing_names, pack_clip_names)

    const selected_names = selection.selected_indices.map(index => human_listing_names[index])
    expect(selected_names.sort()).toEqual([...pack_clip_names].sort())
    expect(selection.missing_clip_names).toEqual([])
  })

  it('does not match look-alike names (case, spaces or prefixes)', () => {
    const selection = AnimationGamePack.resolve_selection(['Idle A', 'idle_a', 'Walk_Formal', 'Run_Female'], ['Idle_A', 'Walk', 'Run'])
    expect(selection.selected_indices).toEqual([])
    expect(selection.missing_clip_names).toEqual(['Idle_A', 'Walk', 'Run'])
  })

  it('reports missing clips and still selects the ones that exist', () => {
    const selection = AnimationGamePack.resolve_selection(['Walk', 'Jog'], ['Walk', 'Run', 'Jog'])
    expect(selection.selected_indices).toEqual([0, 1])
    expect(selection.missing_clip_names).toEqual(['Run'])
  })

  it('uses only the first animation when a name appears twice', () => {
    const selection = AnimationGamePack.resolve_selection(['Walk', 'Jog', 'Walk'], ['Walk', 'Walk'])
    expect(selection.selected_indices).toEqual([0])
    expect(selection.missing_clip_names).toEqual([])
  })
})

describe('AnimationSearch.select_only_animations_by_name', () => {
  let animation_search: AnimationSearch

  function make_clip_pair (name: string): TransformedAnimationClipPair {
    const clip = new AnimationClip(name, 1, [])
    return {
      original_animation_clip: clip,
      display_animation_clip: clip.clone(),
      metadata: { source_type: 'default-library', tags: [] }
    }
  }

  beforeEach(() => {
    document.body.innerHTML = '<input id="animation-filter"><div id="animations-items"></div>'
    // jsdom has no IntersectionObserver (used for lazy video previews)
    vi.stubGlobal('IntersectionObserver', class {
      observe (): void {}
      disconnect (): void {}
    })

    const theme_manager = Object.assign(new EventTarget(), {
      get_current_theme: () => 'dark'
    }) as unknown as ThemeManager

    animation_search = new AnimationSearch('animation-filter', 'animations-items', theme_manager, SkeletonType.Human)
    animation_search.initialize_animations(human_listing_names.map(make_clip_pair))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selects only the pack clips and deselects everything else', () => {
    // pre-select a clip outside the pack, it must be deselected
    animation_search.toggle_select_all_animations()
    expect(animation_search.get_selected_animations().length).toBe(human_listing_names.length)

    const missing_clip_names = animation_search.select_only_animations_by_name(AnimationGamePack.get_clip_names(SkeletonType.Human))

    expect(missing_clip_names).toEqual([])
    const selected_names = animation_search.get_selected_animations().map(animation => animation.name)
    expect(selected_names.sort()).toEqual([...AnimationGamePack.get_clip_names(SkeletonType.Human)].sort())
    expect(animation_search.get_selected_export_animation_count()).toBe(7)
  })

  it('updates the rendered checkboxes and notifies export listeners', () => {
    const on_export_options_changed = vi.fn()
    animation_search.addEventListener('export-options-changed', on_export_options_changed)

    animation_search.select_only_animations_by_name(['Walk', 'Jog'])

    const checked_names = Array.from(document.querySelectorAll<HTMLInputElement>('#animations-items input[type="checkbox"]'))
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.name)
    expect(checked_names.sort()).toEqual(['Jog', 'Walk'])
    expect(on_export_options_changed).toHaveBeenCalledTimes(1)
    expect((on_export_options_changed.mock.calls[0][0] as CustomEvent).detail.exportAnimationCount).toBe(2)
  })

  it('returns the clip names that are not in the listing', () => {
    const missing_clip_names = animation_search.select_only_animations_by_name(['Walk', 'Run'])
    expect(missing_clip_names).toEqual(['Run'])
    expect(animation_search.get_selected_animations().map(animation => animation.name)).toEqual(['Walk'])
  })
})
