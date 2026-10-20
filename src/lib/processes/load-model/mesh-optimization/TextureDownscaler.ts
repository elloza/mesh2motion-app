import { type Material, Source, type Texture } from 'three'

type TextureImage = Texture['image']

/**
 * Shrinks the textures of a model. AI-generated models often ship 4096x4096
 * maps, which do not hold that much real detail. They make the export several
 * times bigger and use a lot of GPU memory.
 *
 * Each texture is replaced by a copy (same UV transform, color space, wrapping)
 * holding a smaller image, and the materials are pointed at the copies. Both
 * exporters (GLB and FBX) re-encode whatever image a texture holds.
 *
 * A new texture object is needed: just swapping texture.image for a smaller
 * image makes three.js write it into the existing, larger GPU texture, which
 * scrambles parts of the atlas.
 */
export class TextureDownscaler {
  /**
   * Every distinct texture used by the given materials (a material can be an
   * array for multi-material meshes). Textures shared between materials are listed once.
   */
  public static collect_textures (materials: Array<Material | Material[]>): Texture[] {
    const textures = new Set<Texture>()
    materials.flat().forEach((material) => {
      Object.values(material).forEach((value) => {
        if (TextureDownscaler.is_texture_with_image(value)) {
          textures.add(value)
        }
      })
    })
    return [...textures]
  }

  /**
   * Size that fits within max_size on its longest side, keeping the aspect
   * ratio. Images that already fit are left at their size.
   */
  public static fitted_size (width: number, height: number, max_size: number): { width: number, height: number } {
    const longest_side = Math.max(width, height)
    if (longest_side <= max_size) return { width, height }
    const scale = max_size / longest_side
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    }
  }

  public static image_size (image: TextureImage): { width: number, height: number } {
    const source = image as { width?: number, height?: number, naturalWidth?: number, naturalHeight?: number }
    return {
      width: source.naturalWidth ?? source.width ?? 0,
      height: source.naturalHeight ?? source.height ?? 0
    }
  }

  /**
   * Points the materials at smaller copies of their textures, no larger than max_size.
   * The originals are released from the GPU but kept, so restore() can put them back.
   * @returns each replaced texture mapped to its smaller copy
   */
  public static downscale_textures (materials: Array<Material | Material[]>, max_size: number): Map<Texture, Texture> {
    const replacements = new Map<Texture, Texture>()

    TextureDownscaler.collect_textures(materials).forEach((texture) => {
      const { width, height } = TextureDownscaler.image_size(texture.image)
      const target = TextureDownscaler.fitted_size(width, height, max_size)
      if (target.width === width && target.height === height) return

      const smaller = texture.clone()
      smaller.source = new Source(TextureDownscaler.resize_image(texture.image, target.width, target.height))
      smaller.needsUpdate = true
      replacements.set(texture, smaller)
    })

    TextureDownscaler.swap_material_textures(materials, replacements)
    replacements.forEach((_, original) => original.dispose())
    return replacements
  }

  /**
   * Points the materials back at the original textures and frees the copies.
   */
  public static restore (materials: Array<Material | Material[]>, replacements: Map<Texture, Texture>): void {
    const originals = new Map<Texture, Texture>()
    replacements.forEach((smaller, original) => originals.set(smaller, original))
    TextureDownscaler.swap_material_textures(materials, originals)
    replacements.forEach(smaller => smaller.dispose())
  }

  private static swap_material_textures (materials: Array<Material | Material[]>, swaps: Map<Texture, Texture>): void {
    if (swaps.size === 0) return
    materials.flat().forEach((material) => {
      const slots = material as unknown as Record<string, unknown>
      Object.entries(slots).forEach(([key, value]) => {
        const replacement = swaps.get(value as Texture)
        if (replacement !== undefined) {
          slots[key] = replacement
        }
      })
    })
  }

  /**
   * Halves the image step by step until the last step reaches the target size.
   * A single big drawImage() step skips most source pixels and looks grainy;
   * halving averages them.
   */
  public static resize_image (image: TextureImage, target_width: number, target_height: number): HTMLCanvasElement {
    let current: HTMLCanvasElement | null = null
    let { width, height } = TextureDownscaler.image_size(image)

    while (width / 2 >= target_width && height / 2 >= target_height) {
      width = Math.round(width / 2)
      height = Math.round(height / 2)
      current = TextureDownscaler.draw_to_canvas(current ?? image as CanvasImageSource, width, height)
    }

    if (current === null || width !== target_width || height !== target_height) {
      current = TextureDownscaler.draw_to_canvas(current ?? image as CanvasImageSource, target_width, target_height)
    }
    return current
  }

  private static draw_to_canvas (source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('Could not create a 2D canvas to resize a texture')
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, width, height)
    return canvas
  }

  private static is_texture_with_image (value: unknown): value is Texture {
    if (value === null || typeof value !== 'object') return false
    const texture = value as Texture
    if (texture.isTexture !== true || texture.image === null || texture.image === undefined) return false
    // cube maps, data textures and video are left alone; only plain 2D images are resized
    const { width, height } = TextureDownscaler.image_size(texture.image)
    return width > 0 && height > 0 && !(texture as { isDataTexture?: boolean }).isDataTexture
  }
}
