import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Quaternion, Vector3, type Object3D } from 'three'

const COMPONENT_ARRAYS: Record<number, Uint16ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor> = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array
}

interface GltfNode {
  mesh?: number
  children?: number[]
  matrix?: number[]
  translation?: [number, number, number]
  rotation?: [number, number, number, number]
  scale?: [number, number, number]
}

/**
 * Minimal GLB reader for tests: positions and indices of every primitive, with
 * the node hierarchy transforms. GLTFLoader would wait forever for textures in
 * the test environment, and the analysis only needs geometry.
 */
export function read_glb_meshes (path: string): Group {
  const file = readFileSync(resolve(process.cwd(), path))
  const json_length = file.readUInt32LE(12)
  const json = JSON.parse(file.subarray(20, 20 + json_length).toString())
  const binary_start = 20 + json_length + 8

  const read_accessor = (index: number, ArrayType: Float32ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor | Uint8ArrayConstructor, item_size: number): Float32Array | Uint16Array | Uint32Array | Uint8Array => {
    const accessor = json.accessors[index]
    const view = json.bufferViews[accessor.bufferView]
    const start = binary_start + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    const bytes = new Uint8Array(accessor.count * item_size * ArrayType.BYTES_PER_ELEMENT)
    bytes.set(file.subarray(start, start + bytes.byteLength))
    return new ArrayType(bytes.buffer)
  }

  const build_mesh = (mesh_index: number): Group => {
    const group = new Group()
    json.meshes[mesh_index].primitives.forEach((primitive: { attributes: { POSITION: number }, indices?: number }) => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(read_accessor(primitive.attributes.POSITION, Float32Array, 3), 3))
      if (primitive.indices !== undefined) {
        const ArrayType = COMPONENT_ARRAYS[json.accessors[primitive.indices].componentType as number]
        geometry.setIndex(new BufferAttribute(read_accessor(primitive.indices, ArrayType, 1), 1))
      }
      group.add(new Mesh(geometry))
    })
    return group
  }

  const build_node = (node_index: number): Object3D => {
    const node: GltfNode = json.nodes[node_index]
    const object = node.mesh !== undefined ? build_mesh(node.mesh) : new Group()
    if (node.matrix !== undefined) {
      object.applyMatrix4(new Matrix4().fromArray(node.matrix))
    } else {
      object.applyMatrix4(new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1]))
      ))
    }
    node.children?.forEach(child => object.add(build_node(child)))
    return object
  }

  const root = new Group()
  const scene = json.scenes[json.scene ?? 0]
  scene.nodes.forEach((node_index: number) => root.add(build_node(node_index)))
  root.updateMatrixWorld(true)
  return root
}
