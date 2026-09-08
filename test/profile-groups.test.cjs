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
