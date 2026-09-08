'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

test('SSH and SFTP tabs can move in both directions without changing their identities', async () => {
  const { moveTab } = await import('../src/tab-order.mjs')
  const order = ['ssh:a', 'sftp:b', 'ssh:c', 'sftp:d']
  assert.deepEqual(moveTab(order, 'ssh:a', 'ssh:c', true), ['sftp:b', 'ssh:c', 'ssh:a', 'sftp:d'])
  assert.deepEqual(moveTab(order, 'sftp:d', 'ssh:a'), ['sftp:d', 'ssh:a', 'sftp:b', 'ssh:c'])
  assert.deepEqual(moveTab(order, 'ssh:a', 'sftp:b'), order)
  assert.deepEqual(moveTab(order, 'missing', 'ssh:a'), order)
  assert.deepEqual(moveTab(order, 'ssh:a', 'ssh:a'), order)
  assert.deepEqual(order, ['ssh:a', 'sftp:b', 'ssh:c', 'sftp:d'])
})
