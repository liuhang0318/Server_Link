'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const dist = path.resolve(__dirname, '..', 'dist')
const bridge = `
(() => {
  let listener;
  let sessionCount = 0;
  const profile = { id: 'render-fixture', name: '开发环境', host: '127.0.0.1', port: 2222, username: 'developer', auth: 'key', privateKeyPath: '/mock/key-not-read' };
  const profiles = [profile, { ...profile, id: 'preview-staging', name: '测试集群1', host: 'staging.example.com' }, { ...profile, id: 'preview-backup', name: '测试集群3', host: 'backup.example.com' }];
  const folders = [];
  window.serverLink = {
    local: {
      list: async id => ({ id: id || 'local-home', path: id === 'local-folder' ? '/Users/demo/Documents' : '/Users/demo', parentId: id === 'local-folder' ? 'local-home' : null, entries: [
        { id: 'local-folder', name: 'Documents', type: 'directory', size: 0, modifiedAt: '2026-09-08T02:00:00.000Z' },
        { id: 'local-file-1', name: 'server-config.json', type: 'file', size: 2048, modifiedAt: '2026-09-08T02:00:00.000Z' },
        { id: 'local-file-2', name: 'release.tar.gz', type: 'file', size: 4280044, modifiedAt: '2026-09-08T02:00:00.000Z' }
      ] }),
      upload: async (ids, targets) => targets.flatMap(target => ids.map(id => ({ connectionId: target.connectionId, name: id === 'local-file-1' ? 'server-config.json' : 'release.tar.gz', success: true })))
    },
    profiles: {
      list: async () => profiles,
      create: async input => profiles.push({ ...input, id: 'fixture-' + profiles.length }),
      createBatch: async (common, text) => text.split(/\\r?\\n/).filter(line => line.trim()).map(line => {
        const fields = line.split(/[,，]/).map(value => value.trim());
        const profile = { ...common, name: fields[0], host: fields.at(-1), id: 'fixture-' + profiles.length };
        profiles.push(profile);
        return profile;
      }),
      update: async (id, input) => Object.assign(profiles.find(item => item.id === id), input)
    },
    privateKeys: {},
    sessions: {
      onEvent: callback => { listener = callback; },
      start: async () => {
        const sessionId = 'preview-' + (++sessionCount);
        setTimeout(() => listener({ type: 'progress', sessionId, phase: 'verifying', logs: 'Connection established.\\nChecking server host key.' }), 100);
        setTimeout(() => listener({ type: 'progress', sessionId, phase: 'connected', logs: 'Authenticated to loopback using publickey.' }), 4000);
        setTimeout(() => listener({ type: 'data', sessionId, data: '\\x1b[32mSERVERLINK_RENDER_READY 中文\\x1b[0m\\r\\nsmoketest$ ' }), 4100);
        return { sessionId };
      },
      write: async (sessionId, data) => listener({ type: 'data', sessionId, data }),
      resize: async () => {},
      close: async sessionId => listener({ type: 'exit', sessionId, exitCode: 0 })
    },
    sftp: {
      // 仅模拟加密密钥的提示分支，不读取路径，不校验或保存输入，也不发出网络请求。
      connect: async (profileId, secret) => {
        if (profileId !== 'render-fixture' && !secret) return { needsSecret: true };
        await new Promise(resolve => setTimeout(resolve, 500));
        return {
        connectionId: 'preview-sftp-' + profileId,
        path: '/var/www',
        entries: [
          { name: 'releases', type: 'directory', size: 0, modifiedAt: '2026-09-08T01:20:00.000Z' },
          { name: 'serverlink.tar.gz', type: 'file', size: 1280440, modifiedAt: '2026-09-08T02:30:00.000Z' },
          { name: 'current', type: 'symlink', size: 18, modifiedAt: '2026-09-08T02:31:00.000Z' }
        ]
        };
      },
      list: async (_connectionId, remotePath) => {
        if (remotePath === '/missing') throw new Error('目录不存在，请检查路径');
        return { path: remotePath, entries: folders };
      },
      upload: async () => ({ canceled: false }),
      uploadFiles: async (_id, _path, files) => files.map(file => ({ name: file.name, success: true })),
      copyBetween: async (_sourceId, sourcePath, _destinationId, _directory) => {
        folders.push({ name: sourcePath.split('/').pop(), type: 'file', size: 1280440, modifiedAt: '2026-09-08T02:31:00.000Z' });
        return true;
      },
      download: async () => ({ canceled: false }),
      mkdir: async (_connectionId, _path, name) => {
        if (folders.some(item => item.name === name)) throw new Error('同名文件夹已存在');
        folders.push({ name, type: 'directory', size: 0, modifiedAt: '2026-09-08T02:31:00.000Z' });
        return true;
      },
      remove: async () => true,
      close: async () => true
    }
  };
})();`

// Serve the exact built UI and CSP with a disposable mock bridge for browser
// rendering QA. This local-only fixture exposes no SSH or filesystem API.
http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (pathname === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript')
    return response.end(bridge)
  }
  if (pathname === '/') {
    response.setHeader('Content-Type', 'text/html')
    return response.end(fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace(
      '<head>', '<head><script src="/fixture.js"></script>'
    ))
  }
  if (/^\/assets\/[A-Za-z0-9_.-]+\.(js|css)$/u.test(pathname)) {
    response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript')
    const file = path.join(dist, pathname)
    if (fs.existsSync(file)) return fs.createReadStream(file).pipe(response)
  }
  response.writeHead(404).end()
}).listen(0, '127.0.0.1', function () {
  console.log(`RENDER_PREVIEW=http://127.0.0.1:${this.address().port}`)
})
