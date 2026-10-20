import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { basename, resolve } from 'path'
import { AnimationGamePack } from './AnimationGamePack'
import { RigConfig } from '../../RigConfig'
import { SkeletonType } from '../../enums/SkeletonType'

// Checks the human game pack against the real animation library files,
// so a typo or a clip swap that breaks looping/chaining is caught by the tests.

interface TrackBoundary {
  first: number[]
  last: number[]
}

// clip name -> "bone.path" (e.g. "pelvis.rotation") -> first/last keyframe values
type ClipBoundaries = Map<string, Map<string, TrackBoundary>>

const component_counts: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 }

/**
 * Minimal GLB reader: only extracts the first and last keyframe of every animation track
 */
function read_clip_boundaries (glb_path: string): ClipBoundaries {
  const glb = readFileSync(glb_path)
  const json_length = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + json_length).toString('utf8'))
  const bin_offset = 20 + json_length + 8

  const read_element = (accessor_index: number, element_index: number): number[] => {
    const accessor = gltf.accessors[accessor_index]
    const buffer_view = gltf.bufferViews[accessor.bufferView]
    const component_count = component_counts[accessor.type]
    const offset = bin_offset + (buffer_view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + element_index * component_count * 4
    return Array.from({ length: component_count }, (_, i) => glb.readFloatLE(offset + i * 4))
  }

  const clips: ClipBoundaries = new Map()
  for (const animation of gltf.animations) {
    const tracks = new Map<string, TrackBoundary>()
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler]
      const keyframe_count: number = gltf.accessors[sampler.output].count
      const track_name = `${gltf.nodes[channel.target.node].name as string}.${channel.target.path as string}`
      tracks.set(track_name, {
        first: read_element(sampler.output, 0),
        last: read_element(sampler.output, keyframe_count - 1)
      })
    }
    clips.set(animation.name, tracks)
  }
  return clips
}

function load_human_library (): ClipBoundaries {
  const library: ClipBoundaries = new Map()
  for (const file_path of RigConfig.get_animation_file_paths(SkeletonType.Human)) {
    // vitest runs from the project root
    const glb_path = resolve(process.cwd(), 'static/animations', basename(file_path))
    read_clip_boundaries(glb_path).forEach((tracks, clip_name) => library.set(clip_name, tracks))
  }
  return library
}

function quaternion_angle_degrees (a: number[], b: number[]): number {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))
  return 2 * Math.acos(dot) * 180 / Math.PI
}

/**
 * Largest bone rotation difference (degrees) and pelvis position difference
 * between the last frame of one clip and the first frame of the next one
 */
function pose_gap (library: ClipBoundaries, from_clip: string, to_clip: string): { max_rotation_degrees: number, pelvis_distance: number } {
  const from_tracks = library.get(from_clip)
  const to_tracks = library.get(to_clip)
  if (from_tracks === undefined || to_tracks === undefined) {
    throw new Error(`Missing clip ${from_clip} or ${to_clip}`)
  }

  let max_rotation_degrees = 0
  let pelvis_distance = 0
  from_tracks.forEach((from_track, track_name) => {
    const to_track = to_tracks.get(track_name)
    if (to_track === undefined) return

    if (track_name.endsWith('.rotation')) {
      max_rotation_degrees = Math.max(max_rotation_degrees, quaternion_angle_degrees(from_track.last, to_track.first))
    } else if (track_name === 'pelvis.translation') {
      pelvis_distance = Math.hypot(...from_track.last.map((value, i) => value - to_track.first[i]))
    }
  })
  return { max_rotation_degrees, pelvis_distance }
}

describe('Human game pack against the animation library', () => {
  const library = load_human_library()
  const pack_clip_names = AnimationGamePack.get_clip_names(SkeletonType.Human)

  // 1 degree / 1 mm: imperceptible, but allows float noise in the exported files
  const max_seam_degrees = 1
  const max_seam_pelvis_distance = 0.001

  it('loads the full human library', () => {
    expect(library.size).toBe(178)
  })

  it('only uses clips that exist in the library', () => {
    const missing_clip_names = pack_clip_names.filter(clip_name => !library.has(clip_name))
    expect(missing_clip_names).toEqual([])
  })

  it.each(['Idle_A', 'Walk', 'Sprint', 'NinjaJump_Idle'])('%s is in the pack and loops seamlessly', (clip_name) => {
    expect(pack_clip_names).toContain(clip_name)
    const gap = pose_gap(library, clip_name, clip_name)
    expect(gap.max_rotation_degrees).toBeLessThan(max_seam_degrees)
    expect(gap.pelvis_distance).toBeLessThan(max_seam_pelvis_distance)
  })

  it.each([
    ['NinjaJump_Start', 'NinjaJump_Idle'],
    ['NinjaJump_Idle', 'NinjaJump_Land']
  ])('jump chain %s -> %s has no pose jump', (from_clip, to_clip) => {
    expect(pack_clip_names).toContain(from_clip)
    expect(pack_clip_names).toContain(to_clip)
    const gap = pose_gap(library, from_clip, to_clip)
    expect(gap.max_rotation_degrees).toBeLessThan(max_seam_degrees)
    expect(gap.pelvis_distance).toBeLessThan(max_seam_pelvis_distance)
  })

  it('jump landing ends close to the idle pose (short crossfade is enough)', () => {
    const gap = pose_gap(library, 'NinjaJump_Land', 'Idle_A')
    expect(gap.pelvis_distance).toBeLessThan(0.01)
    expect(gap.max_rotation_degrees).toBeLessThan(20)
  })
})
