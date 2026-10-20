import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type AnimationClip } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Loads the animation clips of a GLB in tests. Images are removed first:
 * GLTFLoader waits forever for textures in the test environment, and only the
 * animation tracks are needed.
 */
export async function load_animation_clips (relative_path: string): Promise<AnimationClip[]> {
  const file = readFileSync(resolve(process.cwd(), relative_path))
  const json_length = file.readUInt32LE(12)
  const json = JSON.parse(file.subarray(20, 20 + json_length).toString())
  const binary_chunk = file.subarray(20 + json_length)

  delete json.images
  delete json.textures
  delete json.samplers
  ;(json.materials ?? []).forEach((material: Record<string, unknown>) => {
    delete material.normalTexture
    delete material.occlusionTexture
    delete material.emissiveTexture
    const pbr = material.pbrMetallicRoughness as Record<string, unknown> | undefined
    if (pbr !== undefined) {
      delete pbr.baseColorTexture
      delete pbr.metallicRoughnessTexture
    }
  })

  // rebuild the GLB: header, JSON chunk padded with spaces to 4 bytes, original binary chunk
  let json_bytes = Buffer.from(JSON.stringify(json))
  if (json_bytes.length % 4 !== 0) {
    json_bytes = Buffer.concat([json_bytes, Buffer.alloc(4 - (json_bytes.length % 4), 0x20)])
  }
  const json_header = Buffer.alloc(8)
  json_header.writeUInt32LE(json_bytes.length, 0)
  json_header.write('JSON', 4, 'ascii')
  const total_length = 12 + 8 + json_bytes.length + binary_chunk.length
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total_length, 8)
  const glb = Buffer.concat([header, json_header, json_bytes, binary_chunk])

  const data = new ArrayBuffer(glb.byteLength)
  new Uint8Array(data).set(glb)
  const gltf = await new GLTFLoader().parseAsync(data, '')
  return gltf.animations
}
