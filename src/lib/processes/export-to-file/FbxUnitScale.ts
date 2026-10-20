import { FbxExportPreset } from './DownloadSettings.ts'

/**
 * GlobalSettings.UnitScaleFactor to write for each FBX preset.
 * FBX measures UnitScaleFactor in centimeters, but three.js scenes (and so the
 * exported vertices and bone translations) are in meters. 100 tells Unreal and
 * Unity that one file unit is one meter, so characters import at real size.
 * The exporter does not bake space transforms for these presets, so this only
 * changes the header, not the geometry.
 */
const FBX_UNIT_SCALE_BY_PRESET: Record<FbxExportPreset, number> = {
  [FbxExportPreset.Unreal]: 100,
  [FbxExportPreset.Unity]: 100
}

export function fbx_unit_scale (preset: FbxExportPreset): number {
  return FBX_UNIT_SCALE_BY_PRESET[preset]
}
