import { SkeletonType } from '../../enums/SkeletonType.ts'
import { DEFAULT_CHARACTER_HEIGHT_M, is_valid_character_height } from './CharacterHeight.ts'

export enum BoneNamingStructure {
  Default = 'default',
  Mixamo = 'mixamo'
}

export enum ExportContents {
  Full = 'full',
  Skeleton = 'skeleton',
  // fork-only: ZIP for Unreal / Unity (always FBX), see EnginePackBuilder
  EnginePack = 'engine-pack'
}

export enum ExportFormat {
  GLB = 'glb',
  FBX = 'fbx'
}

export enum FbxExportPreset {
  Unreal = 'unreal',
  // Blender = 'blender',
  // ThreeJS = 'threejs',
  Unity = 'unity',
  // Maya = 'maya'
}

export class DownloadSettings extends EventTarget {
  private selected_bone_naming_structure: BoneNamingStructure = this.get_default_bone_naming_structure()
  private selected_export_contents: ExportContents = this.get_default_export_contents()
  private selected_export_format: ExportFormat = this.get_default_export_format()
  private selected_fbx_export_preset: FbxExportPreset = this.get_default_fbx_export_preset()
  private dom_download_settings_popup: HTMLElement | null = null
  private dom_download_settings_toggle: HTMLButtonElement | null = null
  private dom_download_settings_panel: HTMLElement | null = null
  private dom_bone_naming_section: HTMLElement | null = null
  private dom_bone_naming_group: HTMLElement | null = null
  private dom_export_contents_group: HTMLElement | null = null
  private dom_export_format_group: HTMLElement | null = null
  private dom_export_format_section: HTMLElement | null = null
  private dom_fbx_preset_section: HTMLElement | null = null
  private dom_fbx_preset_group: HTMLElement | null = null

  // character height for FBX downloads (meters). null keeps the size of the model
  private selected_character_height: number | null = DEFAULT_CHARACTER_HEIGHT_M
  private model_height: number = 0
  private dom_character_height_section: HTMLElement | null = null
  private dom_character_height_input: HTMLInputElement | null = null
  private dom_character_height_model_button: HTMLButtonElement | null = null
  private dom_character_height_human_button: HTMLButtonElement | null = null
  private dom_character_height_hint: HTMLElement | null = null

  constructor () {
    super()
    this.initialize_dom_elements()
    this.update_fbx_preset_ui_visibility()
    this.add_event_listeners()
  }

  public bone_naming_structure (): BoneNamingStructure {
    return this.selected_bone_naming_structure
  }

  public export_contents (): ExportContents {
    return this.selected_export_contents
  }

  public export_format (): ExportFormat {
    return this.selected_export_format
  }

  public fbx_export_preset (): FbxExportPreset {
    return this.selected_fbx_export_preset
  }

  /**
   * Height (meters) the exported FBX character should have, or null to keep the model size
   */
  public character_height (): number | null {
    return this.selected_character_height
  }

  /**
   * Tell the settings how tall the model currently is, for the hint and the
   * "model size" button. Resets the choice to the default height.
   */
  public set_model_height (height: number): void {
    this.model_height = height
    this.set_character_height(DEFAULT_CHARACTER_HEIGHT_M)
  }

  private set_character_height (height: number | null): void {
    this.selected_character_height = height
    if (this.dom_character_height_input !== null) {
      const shown_height = height ?? this.model_height
      this.dom_character_height_input.value = shown_height > 0 ? shown_height.toFixed(2) : ''
    }
    if (this.dom_character_height_model_button !== null) {
      this.dom_character_height_model_button.textContent = this.model_height > 0 ? `Model size (${this.model_height.toFixed(2)} m)` : 'Model size'
    }
    if (this.dom_character_height_hint !== null) {
      this.dom_character_height_hint.textContent = height === null
        ? 'The model keeps its own size.'
        : `The character is scaled to ${height.toFixed(2)} m. The Unreal mannequin is 1.80 m.`
    }
  }

  // The download settings popup is available for all skeleton types. The bone naming
  // options only apply to the human skeleton, so that section is shown/hidden here while
  // the export contents options remain available regardless of skeleton type.
  public update_download_settings_ui_visibility (skeleton_type: SkeletonType): void {
    // reset to defaults
    this.selected_bone_naming_structure = this.get_default_bone_naming_structure()
    this.set_radio_group_value(this.dom_bone_naming_group, 'bone-naming-structure', this.selected_bone_naming_structure)

    this.selected_export_contents = this.get_default_export_contents()
    this.set_radio_group_value(this.dom_export_contents_group, 'export-contents', this.selected_export_contents)

    this.selected_export_format = this.get_default_export_format()
    this.set_radio_group_value(this.dom_export_format_group, 'export-format', this.selected_export_format)

    this.selected_fbx_export_preset = this.get_default_fbx_export_preset()
    this.set_radio_group_value(this.dom_fbx_preset_group, 'fbx-export-preset', this.selected_fbx_export_preset)

    const is_human_skeleton = skeleton_type === SkeletonType.Human

    // Only the bone naming section is human-only; the popup itself is always available.
    if (this.dom_bone_naming_section !== null) {
      this.dom_bone_naming_section.style.display = is_human_skeleton ? '' : 'none'
    }

    this.update_fbx_preset_ui_visibility()
  }

  private initialize_dom_elements (): void {
    this.dom_download_settings_popup = document.querySelector('#download-settings-popup')
    this.dom_download_settings_toggle = document.querySelector('#download-settings-toggle')
    this.dom_download_settings_panel = document.querySelector('#download-settings')
    this.dom_bone_naming_section = document.querySelector('#download-bone-naming-section')
    this.dom_bone_naming_group = document.querySelector('#download-bone-naming-group')
    this.dom_export_contents_group = document.querySelector('#download-export-contents-group')
    this.dom_export_format_group = document.querySelector('#download-export-format-group')
    this.dom_export_format_section = document.querySelector('#download-export-format-section')
    this.dom_fbx_preset_section = document.querySelector('#download-fbx-preset-section')
    this.dom_fbx_preset_group = document.querySelector('#download-fbx-preset-group')
    this.dom_character_height_section = document.querySelector('#download-character-height-section')
    this.dom_character_height_input = document.querySelector('#download-character-height')
    this.dom_character_height_model_button = document.querySelector('#download-character-height-model')
    this.dom_character_height_human_button = document.querySelector('#download-character-height-human')
    this.dom_character_height_hint = document.querySelector('#download-character-height-hint')
    this.set_character_height(this.selected_character_height)
  }

  private add_event_listeners (): void {
    this.dom_download_settings_toggle?.addEventListener('click', () => {
      this.set_popup_visibility(this.dom_download_settings_panel?.hidden !== false)
    })

    document.addEventListener('click', (event: MouseEvent) => {
      if (this.dom_download_settings_panel?.hidden !== false) {
        return
      }

      const clicked_element = event.target as Node | null
      if (clicked_element === null) {
        return
      }

      if (this.dom_download_settings_popup?.contains(clicked_element) !== true) {
        this.set_popup_visibility(false)
      }
    })

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.set_popup_visibility(false)
      }
    })

    this.dom_bone_naming_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'bone-naming-structure') {
        return
      }

      if (this.is_bone_naming_structure(selected_radio.value)) {
        this.selected_bone_naming_structure = selected_radio.value
      } else {
        this.selected_bone_naming_structure = this.get_default_bone_naming_structure()
      }

      this.dispatchEvent(new CustomEvent('bone-naming-structure-changed', {
        detail: { boneNamingStructure: this.selected_bone_naming_structure }
      }))
    })

    this.dom_export_contents_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'export-contents') {
        return
      }

      if (this.is_export_contents(selected_radio.value)) {
        this.selected_export_contents = selected_radio.value
      } else {
        this.selected_export_contents = this.get_default_export_contents()
      }

      this.dispatchEvent(new CustomEvent('export-contents-changed', {
        detail: { exportContents: this.selected_export_contents }
      }))

      this.update_fbx_preset_ui_visibility()
    })

    this.dom_export_format_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'export-format') {
        return
      }

      if (this.is_export_format(selected_radio.value)) {
        this.selected_export_format = selected_radio.value
      } else {
        this.selected_export_format = this.get_default_export_format()
      }

      this.dispatchEvent(new CustomEvent('export-format-changed', {
        detail: { exportFormat: this.selected_export_format }
      }))

      this.update_fbx_preset_ui_visibility()
    })

    this.dom_character_height_input?.addEventListener('change', () => {
      const value = parseFloat(this.dom_character_height_input?.value ?? '')
      if (is_valid_character_height(value)) {
        this.set_character_height(value)
      } else {
        this.set_character_height(this.selected_character_height) // put the last valid value back
      }
    })

    this.dom_character_height_human_button?.addEventListener('click', () => {
      this.set_character_height(DEFAULT_CHARACTER_HEIGHT_M)
    })

    this.dom_character_height_model_button?.addEventListener('click', () => {
      this.set_character_height(null)
    })

    this.dom_fbx_preset_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'fbx-export-preset') {
        return
      }

      if (this.is_fbx_export_preset(selected_radio.value)) {
        this.selected_fbx_export_preset = selected_radio.value
      } else {
        this.selected_fbx_export_preset = this.get_default_fbx_export_preset()
      }

      this.dispatchEvent(new CustomEvent('fbx-export-preset-changed', {
        detail: { fbxExportPreset: this.selected_fbx_export_preset }
      }))
    })
  }

  private update_fbx_preset_ui_visibility (): void {
    if (this.dom_fbx_preset_section === null) {
      return
    }

    // the engine pack is always FBX, so it needs the preset but not the format choice
    const is_engine_pack = this.selected_export_contents === ExportContents.EnginePack
    const should_show_fbx_preset = this.selected_export_format === ExportFormat.FBX || is_engine_pack
    this.dom_fbx_preset_section.hidden = !should_show_fbx_preset
    // the character height applies to FBX files
    if (this.dom_character_height_section !== null) {
      this.dom_character_height_section.hidden = !should_show_fbx_preset
    }

    if (this.dom_export_format_section !== null) {
      this.dom_export_format_section.hidden = is_engine_pack
    }
  }

  private set_popup_visibility (is_visible: boolean): void {
    if (this.dom_download_settings_panel !== null) {
      this.dom_download_settings_panel.hidden = !is_visible
    }

    if (this.dom_download_settings_toggle !== null) {
      this.dom_download_settings_toggle.setAttribute('aria-expanded', is_visible ? 'true' : 'false')
    }
  }

  private set_radio_group_value (group: HTMLElement | null, name: string, value: string): void {
    const option_radio = group?.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
    if (option_radio !== null && option_radio !== undefined) {
      option_radio.checked = true
    }
  }

  private is_bone_naming_structure (value: string): value is BoneNamingStructure {
    return Object.values(BoneNamingStructure).includes(value as BoneNamingStructure)
  }

  private is_export_contents (value: string): value is ExportContents {
    return Object.values(ExportContents).includes(value as ExportContents)
  }

  private is_export_format (value: string): value is ExportFormat {
    return Object.values(ExportFormat).includes(value as ExportFormat)
  }

  private is_fbx_export_preset (value: string): value is FbxExportPreset {
    return Object.values(FbxExportPreset).includes(value as FbxExportPreset)
  }

  private get_default_fbx_export_preset (): FbxExportPreset {
    return this.get_first_enum_value(FbxExportPreset)
  }

  private get_default_bone_naming_structure (): BoneNamingStructure {
    return this.get_first_enum_value(BoneNamingStructure)
  }

  private get_default_export_contents (): ExportContents {
    return this.get_first_enum_value(ExportContents)
  }

  private get_default_export_format (): ExportFormat {
    return this.get_first_enum_value(ExportFormat)
  }

  private get_first_enum_value<T extends string> (enum_object: Record<string, T>): T {
    const enum_values = Object.values(enum_object)
    if (enum_values.length === 0) {
      throw new Error('Enum has no values')
    }

    return enum_values[0]
  }
}
