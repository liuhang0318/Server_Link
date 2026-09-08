'use strict'

const net = require('node:net')
const path = require('node:path')

const SSH_PATH = '/usr/bin/ssh'
const PROFILE_INPUT_KEYS = new Set([
  'name',
  'host',
  'port',
  'username',
  'auth',
  'privateKeyPath'
])

function requirePlainObject (value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
}

function requireExactKeys (value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${key}`)
    }
  }
}

function requireTrimmedText (value, label, maximumLength) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string`)
  }

  const normalized = value.trim()
  const containsControlCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
  if (!normalized || normalized.length > maximumLength || containsControlCharacter) {
    throw new TypeError(`${label} is invalid`)
  }
  return normalized
}

/**
 * Validates a host without accepting whitespace or option-like values that
 * could change how the native ssh process interprets its final operand.
 */
function validateHost (value) {
  const host = requireTrimmedText(value, 'host', 253)
  if (net.isIP(host)) return host

  const labels = host.split('.')
  const validDnsName = labels.every(label => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  ))
  if (!validDnsName) throw new TypeError('host is invalid')
  return host
}

/** Validates the remote login name as one indivisible ssh argument. */
function validateUsername (value) {
  const username = requireTrimmedText(value, 'username', 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(username)) {
    throw new TypeError('username is invalid')
  }
  return username
}

/** Validates an SSH TCP port without coercing strings or partial numbers. */
function validatePort (value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError('port must be an integer between 1 and 65535')
  }
  return value
}

/**
 * Accepts only absolute local key paths. The path remains a single argv item,
 * so spaces are supported without invoking a shell.
 */
function validatePrivateKeyPath (value) {
  const keyPath = requireTrimmedText(value, 'privateKeyPath', 4096)
  if (!path.isAbsolute(keyPath)) {
    throw new TypeError('privateKeyPath must be absolute')
  }
  return path.normalize(keyPath)
}

/**
 * Normalizes the only profile fields ServerLink persists. Unexpected fields
 * are rejected so passwords and future secret-shaped values cannot slip into
 * the JSON store through a compromised renderer.
 */
function normalizeProfileInput (value) {
  requirePlainObject(value, 'profile')
  requireExactKeys(value, PROFILE_INPUT_KEYS, 'profile')

  const auth = value.auth
  if (auth !== 'agent' && auth !== 'key' && auth !== 'password') {
    throw new TypeError('auth must be agent, key, or password')
  }

  const privateKeyPath = auth === 'key'
    ? validatePrivateKeyPath(value.privateKeyPath)
    : null

  return {
    name: requireTrimmedText(value.name, 'name', 80),
    host: validateHost(value.host),
    port: validatePort(value.port),
    username: validateUsername(value.username),
    auth,
    privateKeyPath
  }
}

function quoteSshConfigValue (value) {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/**
 * Builds the fixed executable and argv for native OpenSSH. Every user value is
 * validated and stays in a separate argv item; callers must never join these
 * values into a command string or execute them through a shell.
 */
function buildSshCommand (profile, options) {
  const normalized = normalizeProfileInput(profile)
  requirePlainObject(options, 'options')
  requireExactKeys(options, new Set(['knownHostsPath']), 'options')
  const knownHostsPath = validatePrivateKeyPath(options.knownHostsPath)

  const args = [
    '-F', 'none',
    '-o', 'StrictHostKeyChecking=ask',
    '-o', 'HashKnownHosts=yes',
    '-o', `UserKnownHostsFile=${quoteSshConfigValue(knownHostsPath)}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ProxyCommand=none',
    '-o', 'ProxyJump=none',
    '-o', 'CanonicalizeHostname=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3'
  ]

  if (normalized.auth === 'key') {
    args.push(
      '-o', 'PubkeyAuthentication=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'IdentitiesOnly=yes',
      '-i', normalized.privateKeyPath
    )
  } else if (normalized.auth === 'agent') {
    // Prevent implicit ~/.ssh identity files from blurring the selected agent-only mode.
    args.push(
      '-o', 'PubkeyAuthentication=yes',
      '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'IdentityFile=none'
    )
  } else {
    // Password keystrokes use only the fixed session-write IPC into this PTY;
    // no secret is represented as a profile field, argv item, or environment value.
    args.push(
      '-o', 'PubkeyAuthentication=no',
      '-o', 'PasswordAuthentication=yes',
      '-o', 'KbdInteractiveAuthentication=yes',
      '-o', 'PreferredAuthentications=keyboard-interactive,password',
      '-o', 'IdentityFile=none'
    )
  }

  args.push('-p', String(normalized.port), '-l', normalized.username, '--', normalized.host)
  return { file: SSH_PATH, args, profile: normalized }
}

module.exports = {
  SSH_PATH,
  buildSshCommand,
  normalizeProfileInput,
  validateHost,
  validatePort,
  validatePrivateKeyPath,
  validateUsername
}
