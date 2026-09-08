'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { parseKey } = require('@electerm/ssh2/lib/protocol/keyParser.js')

function hostCandidates (host, port) {
  const normalizedHost = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host
  return new Set([normalizedHost, `[${normalizedHost}]:${port}`])
}

function matchesHashedHost (token, candidate) {
  const parts = token.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const expected = Buffer.from(parts[3], 'base64')
    const actual = crypto.createHmac('sha1', Buffer.from(parts[2], 'base64'))
      .update(candidate)
      .digest()
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function matchesHostField (field, candidates) {
  let matched = false
  for (const token of field.split(',').map(value => value.trim()).filter(Boolean)) {
    const negative = token.startsWith('!')
    const value = negative ? token.slice(1) : token
    const tokenMatches = [...candidates].some(candidate => (
      value.startsWith('|1|') ? matchesHashedHost(value, candidate) : value === candidate
    ))
    if (negative && tokenMatches) return false
    if (tokenMatches) matched = true
  }
  return matched
}

function parseLine (line) {
  const parts = line.trim().split(/\s+/u)
  if (!parts[0] || parts[0].startsWith('#')) return null
  const marker = parts[0].startsWith('@') ? parts.shift() : null
  if (parts.length < 3) return null
  return { marker, hosts: parts[0], keyType: parts[1], keyData: parts[2] }
}

function keyMetadata (hostKey) {
  const parsed = parseKey(hostKey)
  if (parsed instanceof Error) throw parsed
  return {
    keyType: parsed.type,
    keyData: parsed.getPublicSSH().toString('base64'),
    fingerprint: `SHA256:${crypto.createHash('sha256').update(hostKey).digest('base64')}`
  }
}

async function readFile (knownHostsPath) {
  try {
    return await fs.readFile(knownHostsPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

/** Checks a raw SSH host key against plain or OpenSSH-hashed app-owned entries. */
async function checkKnownHost ({ knownHostsPath, host, port, hostKey }) {
  const metadata = keyMetadata(hostKey)
  const candidates = hostCandidates(host, port)
  const entries = (await readFile(knownHostsPath))
    .split(/\r?\n/u)
    .map(parseLine)
    .filter(entry => entry && matchesHostField(entry.hosts, candidates))
  const sameType = entries.filter(entry => entry.keyType === metadata.keyType)
  const exactEntries = sameType.filter(entry => entry.keyData === metadata.keyData)

  // A revoked marker always wins even if a duplicate non-revoked line exists.
  if (exactEntries.some(entry => entry.marker === '@revoked')) return { status: 'revoked', ...metadata }
  if (exactEntries.length) return { status: 'match', ...metadata }
  if (sameType.length) return { status: 'mismatch', ...metadata }
  return { status: 'not-found', ...metadata }
}

/** Appends a privacy-preserving hashed host token with owner-only permissions. */
async function trustKnownHost ({ knownHostsPath, host, port, hostKey }) {
  const metadata = keyMetadata(hostKey)
  const normalizedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const candidate = port === 22 ? normalizedHost : `[${normalizedHost}]:${port}`
  const salt = crypto.randomBytes(20)
  const digest = crypto.createHmac('sha1', salt).update(candidate).digest()
  const token = `|1|${salt.toString('base64')}|${digest.toString('base64')}`

  await fs.mkdir(path.dirname(knownHostsPath), { recursive: true, mode: 0o700 })
  await fs.appendFile(
    knownHostsPath,
    `${token} ${metadata.keyType} ${metadata.keyData}\n`,
    { mode: 0o600 }
  )
  // Repair permissions on an existing file before another connection can read it.
  await fs.chmod(knownHostsPath, 0o600)
  return metadata
}

module.exports = { checkKnownHost, trustKnownHost }
