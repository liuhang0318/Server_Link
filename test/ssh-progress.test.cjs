'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { sshProgress } = require('../lib/ssh-progress.cjs')

test('connection stages require OpenSSH authentication success rather than a shell prompt', () => {
  assert.equal(sshProgress('Connecting to example.com port 22'), 'connecting')
  assert.equal(sshProgress('debug1: Connection established.'), 'verifying')
  assert.equal(sshProgress('debug1: Next authentication method: publickey'), 'authenticating')
  assert.equal(sshProgress('root@server:~#'), 'connecting')
  assert.equal(sshProgress('Authenticated with partial success.'), 'connecting')
  assert.equal(sshProgress('Authenticated to example.com using publickey.'), 'connected')
  assert.equal(sshProgress('Host key verification failed.'), 'failed')
})
