import { describe, it, expect, vi, afterEach } from 'vitest'
import { DataTexture, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Texture } from 'three'
import { TextureDownscaler } from './TextureDownscaler'
import { MeshOptimizationPanel } from './MeshOptimizationPanel'

function texture_of_size (width: number, height: number): Texture {
  return new Texture({ width, height } as unknown as HTMLImageElement)
}

describe('TextureDownscaler.fitted_size', () => {
  it('scales the longest side down to the limit and keeps the aspect ratio', () => {
    expect(TextureDownscaler.fitted_size(4096, 2048, 1024)).toEqual({ width: 1024, height: 512 })
    expect(TextureDownscaler.fitted_size(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 })
  })

  it('leaves images that already fit at their size', () => {
    expect(TextureDownscaler.fitted_size(512, 512, 2048)).toEqual({ width: 512, height: 512 })
  })
})

describe('TextureDownscaler.collect_textures', () => {
  it('lists each image texture once, across materials and material arrays', () => {
    const shared = texture_of_size(4096, 4096)
    const normal = texture_of_size(4096, 4096)
    const first = new MeshStandardMaterial({ map: shared, normalMap: normal })
    const second = new MeshStandardMaterial({ map: shared })

    const textures = TextureDownscaler.collect_textures([first, [second]])

    expect(textures).toHaveLength(2)
    expect(textures).toContain(shared)
    expect(textures).toContain(normal)
  })

  it('skips data textures and textures without an image', () => {
    const material = new MeshStandardMaterial({
      map: new DataTexture(new Uint8Array(4), 1, 1),
      roughnessMap: new Texture()
    })

    expect(TextureDownscaler.collect_textures([material])).toEqual([])
  })
})

describe('TextureDownscaler.downscale_textures', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives materials a new texture with its own image source and the same settings', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    const original = texture_of_size(4096, 2048)
    original.flipY = false
    original.colorSpace = SRGBColorSpace
    original.wrapS = RepeatWrapping
    original.channel = 1
    const material = new MeshStandardMaterial({ map: original, emissiveMap: original })

    const replacements = TextureDownscaler.downscale_textures([material], 1024)
    const smaller = material.map as Texture

    // a new Source is what makes three.js allocate a new, smaller GPU texture;
    // reusing the old one leaves parts of the original atlas on screen
    expect(smaller).not.toBe(original)
    expect(smaller.source).not.toBe(original.source)
    expect(material.emissiveMap).toBe(smaller)
    expect(replacements.get(original)).toBe(smaller)
    expect(TextureDownscaler.image_size(smaller.image)).toEqual({ width: 1024, height: 512 })
    expect(smaller.flipY).toBe(false)
    expect(smaller.colorSpace).toBe(SRGBColorSpace)
    expect(smaller.wrapS).toBe(RepeatWrapping)
    expect(smaller.channel).toBe(1)

    TextureDownscaler.restore([material], replacements)
    expect(material.map).toBe(original)
    expect(material.emissiveMap).toBe(original)
  })

  it('leaves textures that already fit untouched', () => {
    const texture = texture_of_size(512, 512)
    const material = new MeshStandardMaterial({ map: texture })

    const replacements = TextureDownscaler.downscale_textures([material], 1024)

    expect(replacements.size).toBe(0)
    expect(material.map).toBe(texture)
  })
})

describe('MeshOptimizationPanel.describe_summary', () => {
  it('describes the triangle, mesh data and texture changes', () => {
    const text = MeshOptimizationPanel.describe_summary({
      triangles_before: 1500000,
      triangles_after: 100000,
      vertices_before: 821618,
      vertices_after: 74000,
      mesh_bytes_before: 72 * 1024 * 1024,
      mesh_bytes_after: 4.5 * 1024 * 1024,
      largest_texture_before: 4096,
      largest_texture_after: 2048,
      texture_pixels_before: 3 * 4096 * 4096,
      texture_pixels_after: 3 * 2048 * 2048,
      relative_error: 0.0003,
      duration_ms: 2300
    })

    expect(text).toBe('Triangles 1,500,000 → 100,000. Mesh data 72.0 MB → 4.5 MB. Textures 4096 → 2048 px (25% of the pixels). Took 2.3 s.')
  })
})
