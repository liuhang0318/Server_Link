'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const dist = path.resolve(__dirname, '..', 'dist')
const bridge = `
(() => {
  let listener;
  let progressListener;
  let sessionCount = 0;
  const sessionPrompts = new Map();
  const profile = { id: 'render-fixture', name: '开发环境', host: '127.0.0.1', port: 2222, username: 'developer', auth: 'key', privateKeyPath: '/mock/key-not-read' };
  const profiles = [profile, { ...profile, id: 'preview-staging', name: '测试集群1', host: 'staging.example.com' }, { ...profile, id: 'preview-backup', name: '测试集群3', host: 'backup.example.com' }];
  // ?organize 与原生 --organize 使用相同名称场景；仅替换静态假配置。
  if (new URLSearchParams(location.search).has('organize')) {
    profiles.splice(0, profiles.length, ...['东京', '后台API', '游戏服', 'mamo线上1', 'mamo线上2'].map((name, index) => ({
      ...profile, id: '00000000-0000-4000-8000-00000000000' + (index + 1), name, username: 'demo', host: 'organize' + index + '.example.com'
    })));
  }
  // ?many 只扩充静态假配置，用来复现多标签/长名称溢出，不读取用户主机信息。
  if (new URLSearchParams(location.search).has('many')) {
    for (let index = 1; index <= 12; index++) profiles.push({ ...profile, id: 'layout-' + index, name: '视觉验收服务器集群-' + index, host: 'layout' + index + '.example.com' });
  }
  const folders = [];
  const uploads = new Map();
  // 静态假进度仅用于 UI 检查，不读取本机文件或访问服务器。
  async function mockBatch(connectionId, names) {
    const operation = { canceled: false };
    uploads.set(connectionId, operation);
    const results = [];
    let transferred = 0;
    const total = names.length * 10485760;
    const report = (name, fileIndex, phase) => progressListener({ connectionId, transferId: 'mock-batch', name, fileIndex, fileCount: names.length, total, transferred, bytesPerSecond: 524288, phase });
    report(names[0], 0, 'preparing');
    for (const [index, name] of names.entries()) {
      for (let step = 0; step <= 20 && !operation.canceled; step++) {
        transferred = index * 10485760 + step * 524288;
        report(name, index + 1, 'uploading');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      results.push(operation.canceled ? { name, success: false, canceled: true, error: '上传已取消' } : { name, success: true });
    }
    report(names.at(-1), names.length, operation.canceled ? 'canceled' : 'completed');
    uploads.delete(connectionId);
    return results;
  }
  window.serverLink = {
    // 网页预览没有原生菜单，只模拟单向 app 事件；实际 ⌘W/⌘Q 另用 Electron 验收。
    app: { onAction: () => () => {} },
    local: {
      list: async id => ({ id: id || 'local-home', path: id === 'local-folder' ? '/Users/demo/Documents' : '/Users/demo', parentId: id === 'local-folder' ? 'local-home' : null, entries: [
        { id: 'local-folder', name: 'Documents', type: 'directory', size: 0, modifiedAt: '2026-09-08T02:00:00.000Z' },
        { id: 'local-file-1', name: 'server-config.json', type: 'file', size: 2048, modifiedAt: '2026-09-08T02:00:00.000Z' },
        { id: 'local-file-2', name: 'release.tar.gz', type: 'file', size: 4280044, modifiedAt: '2026-09-08T02:00:00.000Z' },
        { id: 'local-file-3', name: '.env.example', type: 'file', size: 128, modifiedAt: '2026-09-08T02:00:00.000Z' }
      ] }),
      upload: async (ids, targets) => {
        const results = [];
        for (const target of targets) results.push(...(await mockBatch(target.connectionId, ids.map(id => id === 'local-folder' ? 'Documents' : id))).map(result => ({ ...result, connectionId: target.connectionId })));
        return results;
      }
    },
    profiles: {
      list: async () => profiles.map(profile => ({ ...profile })),
      // 在内存中模拟完整快照返回；不触及真实配置文件或远程连接。
      organize: async change => {
        const selected = new Set(change.ids || []);
        let next = profiles.map(profile => {
          const updated = { ...profile };
          if (selected.has(profile.id)) {
            // null 恢复自动分组，空字符串保留显式独立，和实际存储契约一致。
            if (change.group === null) delete updated.group;
            else updated.group = change.group;
          }
          return updated;
        });
        if (change.order) {
          const byId = new Map(next.map(profile => [profile.id, profile]));
          if (change.order.length !== profiles.length || new Set(change.order).size !== profiles.length || change.order.some(id => !byId.has(id))) {
            throw new Error('预览排序必须包含全部服务器且不可重复');
          }
          next = change.order.map((id, order) => ({ ...byId.get(id), order }));
        }
        profiles.splice(0, profiles.length, ...next);
        return profiles.map(profile => ({ ...profile }));
      },
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
      start: async profileId => {
        const sessionId = 'preview-' + (++sessionCount);
        const prompt = '[' + (profiles.find(item => item.id === profileId)?.username || 'developer') + '@preview ~]$ ';
        sessionPrompts.set(sessionId, prompt);
        setTimeout(() => listener({ type: 'progress', sessionId, phase: 'verifying', logs: 'Connection established.\\nChecking server host key.' }), 100);
        setTimeout(() => listener({ type: 'progress', sessionId, phase: 'connected', logs: 'Authenticated to loopback using publickey.' }), 4000);
        setTimeout(() => listener({ type: 'data', sessionId, data: '\\x1b[32mSERVERLINK_RENDER_READY 中文\\x1b[0m\\r\\n' + prompt }), 4100);
        return { sessionId };
      },
      // ?slow-echo 模拟网络延迟，验证原位预显到真实回显的交接；回车只生成空提示符，绝不执行命令。
      write: async (sessionId, data) => {
        const prompt = sessionPrompts.get(sessionId);
        if (!prompt) return false;
        const echo = data.replace(/\\x7f/g, '\\b \\b').replace(/\\r\\n|\\r|\\n/g, '\\r\\n' + prompt);
        setTimeout(() => {
          if (sessionPrompts.has(sessionId)) listener({ type: 'data', sessionId, data: echo });
        }, new URLSearchParams(location.search).has('slow-echo') ? 1200 : 0);
        return true;
      },
      resize: async () => {},
      close: async sessionId => {
        // 已关闭连接不再发出延迟回显，避免验收时旧会话事件污染新标签。
        sessionPrompts.delete(sessionId);
        listener({ type: 'exit', sessionId, exitCode: 0 });
      }
    },
    sftp: {
      onProgress: callback => { progressListener = callback; },
      cancelUpload: async id => { const operation = uploads.get(id); if (operation) operation.canceled = true; return Boolean(operation); },
      cancelConnect: async () => {},
      // 仅模拟连接延迟，不读取路径、不校验或保存输入，也不发出网络请求。
      connect: async (profileId, secret) => {
        await new Promise(resolve => setTimeout(resolve, profileId === 'render-fixture' ? 1500 : 10000));
        return {
        connectionId: 'preview-sftp-' + profileId,
        path: '/var/www',
        entries: [
          { name: 'releases', type: 'directory', size: 0, modifiedAt: '2026-09-08T01:20:00.000Z' },
          { name: 'serverlink.tar.gz', type: 'file', size: 1280440, modifiedAt: '2026-09-08T02:30:00.000Z' },
          { name: 'current', type: 'symlink', size: 18, modifiedAt: '2026-09-08T02:31:00.000Z' },
          { name: '.env.example', type: 'file', size: 128, modifiedAt: '2026-09-08T02:31:00.000Z' }
        ]
        };
      },
      list: async (_connectionId, remotePath) => {
        if (remotePath === '/missing') throw new Error('目录不存在，请检查路径');
        return { path: remotePath, entries: folders };
      },
      upload: async id => ({ canceled: false, results: await mockBatch(id, ['example-folder/nested/sample.txt']) }),
      uploadFiles: async (id, _path, files) => {
        return mockBatch(id, files.map(file => file.name));
      },
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
