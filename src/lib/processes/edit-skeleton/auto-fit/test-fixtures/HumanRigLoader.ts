import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Object3D, type Skeleton } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Generators } from '../../../../Generators'
import { HandHelper } from '../../../load-skeleton/HandHelper'
import { HandSkeletonType } from '../../../../enums/SkeletonType'

/**
 * Loads the real Mesh2Motion human rig the same way the app does
 * (StepLoadSkeleton -> StepEditSkeleton), so tests run against the actual bone
 * names, hierarchy and rest rotations.
 */
export async function load_human_rig_skeleton (hand_type: HandSkeletonType = HandSkeletonType.AllFingers): Promise<{ armature: Object3D, skeleton: Skeleton }> {
  const file = readFileSync(resolve(process.cwd(), 'static/rigs/rig-human.glb'))
  // copy into an ArrayBuffer of the test environment, GLTFLoader checks `instanceof ArrayBuffer`
  const data = new ArrayBuffer(file.byteLength)
  new Uint8Array(data).set(file)
  const gltf = await new GLTFLoader().parseAsync(data, '')

  let original_armature: Object3D | null = null
  gltf.scene.traverse((child: Object3D) => {
    if (child.type === 'Bone' && original_armature === null) {
      original_armature = child.parent
    }
  })
  if (original_armature === null) {
    throw new Error('rig-human.glb has no bones')
  }

  const armature = (original_armature as Object3D).clone()
  new HandHelper().modify_hand_skeleton(armature, hand_type)
  armature.position.set(0, 0, 0)
  armature.updateWorldMatrix(true, true)

  const skeleton = Generators.create_skeleton(armature.children[0])
  skeleton.bones[0].updateWorldMatrix(true, true)
  return { armature, skeleton }
}
