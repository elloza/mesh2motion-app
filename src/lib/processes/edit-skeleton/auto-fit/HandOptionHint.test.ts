import { describe, it, expect } from 'vitest'
import { rig_has_individual_fingers } from './HandOptionHint'
import { HandSkeletonType } from '../../../enums/SkeletonType'
import { load_human_rig_skeleton } from './test-fixtures/HumanRigLoader'

describe('rig_has_individual_fingers', () => {
  it.each([
    [HandSkeletonType.AllFingers, true],
    [HandSkeletonType.SimplifiedHand, true],
    [HandSkeletonType.ThumbAndIndex, false],
    [HandSkeletonType.SingleBone, false]
  ])('%s -> %s', async (hand_type, expected) => {
    const { skeleton } = await load_human_rig_skeleton(hand_type)
    expect(rig_has_individual_fingers(skeleton.bones)).toBe(expected)
  })
})
