'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

test('named prefixes group naturally without combining unrelated IP names', async () => {
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const profiles = ['jp', 'mamo线上10', 'mamo线上3', 'mamo线上1', '192.0.2.10', '192.0.2.11', '测试-api', '测试-web'].map((name, id) => ({ name, id }))
  const result = groupProfiles(profiles)
  assert.equal(result[0].grouped, false)
  assert.equal(result[1].name, 'mamo线上')
  assert.deepEqual(result[1].profiles.map(item => item.name), ['mamo线上1', 'mamo线上3', 'mamo线上10'])
  assert.equal(result[2].grouped, false)
  assert.equal(result[3].grouped, false)
  assert.equal(result[4].name, '测试')
  assert.equal(result[4].profiles.length, 2)
  assert.equal(profiles[1].name, 'mamo线上10')
})

test('manual groups include single servers and combine case-insensitively with matching automatic prefixes', async () => {
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'api', name: 'production-api', group: ' Operations ' },
    { id: 'ops', name: 'operations2' },
    { id: 'web', name: 'staging-web', group: 'OPERATIONS' },
    { id: 'solo', name: 'jp', group: '独立环境' }
  ]
  const before = structuredClone(profiles)
  const groups = groupProfiles(profiles)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].key, 'group:operations')
  assert.equal(groups[0].name, 'Operations')
  assert.equal(groups[0].manual, true)
  assert.deepEqual(groups[0].profiles.map(profile => profile.id), ['ops', 'api', 'web'])
  assert.equal(groups[1].grouped, true)
  assert.equal(groups[1].manual, true)
  assert.deepEqual(profiles, before)
})

test('explicit ungrouped servers bypass automatic prefixes and cannot collide with manual group keys', async () => {
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'one', name: 'mamo1', group: '' },
    { id: 'two', name: 'mamo2', group: '' },
    { id: 'three', name: 'mamo3' },
    { id: 'four', name: 'mamo4' },
    { id: 'named', name: 'custom', group: 'single:one' }
  ]
  const groups = groupProfiles(profiles)
  assert.deepEqual(groups.map(group => group.key), ['single:one', 'single:two', 'group:mamo', 'group:single:one'])
  assert.deepEqual(groups.map(group => group.grouped), [false, false, true, true])
  assert.deepEqual(groups.map(group => group.manual), [false, false, false, true])
  assert.equal(groups[0].name, 'mamo1')
  assert.deepEqual(groups[2].profiles.map(profile => profile.id), ['three', 'four'])
})

test('saved order preserves group member input order and group blocks follow their first appearance', async () => {
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'last', name: 'prod10', order: 0 },
    { id: 'solo', name: 'jp', group: '' },
    { id: 'first', name: 'prod1' },
    { id: 'manual-last', name: 'z', group: 'Custom' },
    { id: 'manual-first', name: 'a', group: 'custom' }
  ]
  const groups = groupProfiles(profiles)
  assert.deepEqual(groups.map(group => group.key), ['group:prod', 'single:solo', 'group:custom'])
  assert.deepEqual(groups[0].profiles.map(profile => profile.id), ['last', 'first'])
  assert.deepEqual(groups[2].profiles.map(profile => profile.id), ['manual-last', 'manual-first'])
  assert.equal(groups[0].manual, false)
  assert.equal(groups[2].manual, true)
})

test('invalid saved order does not disable legacy natural sorting and automatic-first groups can become manual', async () => {
  const { groupProfiles } = await import('../src/profile-groups.mjs')
  const groups = groupProfiles([
    { id: 'last', name: 'Prod10', order: -1 },
    { id: 'first', name: 'Prod1', order: 1.5 },
    { id: 'manual', name: 'database', group: 'PROD', order: '0' }
  ])
  assert.equal(groups[0].name, 'Prod')
  assert.equal(groups[0].key, 'group:prod')
  assert.equal(groups[0].manual, true)
  assert.deepEqual(groups[0].profiles.map(profile => profile.id), ['manual', 'first', 'last'])
})

test('drag reorder uses displayed legacy order and keeps multi-selection in its current visual order', async () => {
  const { moveProfileOrder } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'ten', name: 'prod10' },
    { id: 'jp', name: 'jp' },
    { id: 'one', name: 'prod1' },
    { id: 'two', name: 'prod2' },
    { id: 'home', name: 'home' }
  ]
  const before = structuredClone(profiles)
  assert.deepEqual(moveProfileOrder(profiles, ['home'], 'one'), ['home', 'one', 'two', 'ten', 'jp'])
  assert.deepEqual(moveProfileOrder(profiles, ['ten', 'one'], 'jp', true), ['two', 'jp', 'one', 'ten', 'home'])
  assert.deepEqual(moveProfileOrder(profiles, ['ten', 'one', 'two'], 'home', true), ['jp', 'home', 'one', 'two', 'ten'])
  assert.deepEqual(profiles, before)
})

test('drag reorder respects saved input order and ignores empty, duplicate, unknown or self-target moves', async () => {
  const { moveProfileOrder } = await import('../src/profile-groups.mjs')
  const profiles = [
    { id: 'ten', name: 'prod10', order: 0 },
    { id: 'one', name: 'prod1', order: 1 },
    { id: 'home', name: 'home', order: 2 }
  ]
  const original = ['ten', 'one', 'home']
  assert.deepEqual(moveProfileOrder(profiles, ['one'], 'home', true), ['ten', 'home', 'one'])
  for (const [moving, target] of [
    [[], 'home'], [null, 'home'], [['one', 'one'], 'home'], [['missing'], 'home'],
    [['one', 'missing'], 'home'], [['one'], 'missing'], [['one'], 'one'], [['one', 'home'], 'home']
  ]) {
    assert.deepEqual(moveProfileOrder(profiles, moving, target), original)
  }
  assert.deepEqual(moveProfileOrder([], ['one'], 'home'), [])
})
