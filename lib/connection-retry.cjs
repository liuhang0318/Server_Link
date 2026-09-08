'use strict'

/** 仅重试连接阶段的临时传输错误；认证、密钥和主机信任错误必须交还用户处理。 */
function isTransientConnectionError (error) {
  const message = typeof error === 'string' ? error : error?.message ?? ''
  if (error?.retryable === false || error?.level === 'client-authentication') return false
  if (/permission denied|authentication failed|all configured authentication|no more authentication methods|passphrase|cannot parse privatekey|host key verification failed|host identification has changed|not trusted|revoked|cancel|closed by user/iu.test(message)) return false
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE'].includes(error?.code) ||
    /connection (?:reset|refused|timed out|closed)|operation timed out|timed out while waiting for handshake|no route to host|network is unreachable|temporary failure in name resolution|socket hang up/iu.test(message)
}

module.exports = { isTransientConnectionError }
