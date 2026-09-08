'use strict'

/** 只解析本机 OpenSSH 的诊断日志来展示阶段，不参与主机信任或认证决策。 */
function sshProgress (log) {
  if (/(?:^|\n)(?:debug1: )?Authenticated to /u.test(log)) return 'connected'
  if (/Host key verification failed|Permission denied|Connection refused|Operation timed out|Could not resolve hostname/u.test(log)) return 'failed'
  if (/Authentications that can continue|Offering public key|Next authentication method/u.test(log)) return 'authenticating'
  if (/Connection established|Remote protocol version|Server host key/u.test(log)) return 'verifying'
  return 'connecting'
}

module.exports = { sshProgress }
