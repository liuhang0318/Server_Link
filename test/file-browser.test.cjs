'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

test('file filtering is case insensitive, literal, nonrecursive and preserves input order', async () => {
  const { filterFiles } = await import('../src/file-browser.mjs')
  const entries = [{ name: '.env' }, { name: 'Release.TAR.gz' }, { name: '中文配置.json' }, { name: 'a[b].txt' }]
  assert.deepEqual(filterFiles(entries, ' TAR '), [entries[1]])
  assert.deepEqual(filterFiles(entries, '中文'), [entries[2]])
  assert.deepEqual(filterFiles(entries, '[b]'), [entries[3]])
  assert.deepEqual(filterFiles(entries, '', false), entries.slice(1))
  assert.equal(entries.length, 4)
})

test('same-directory refresh replaces tokens but preserves selected file names only', async () => {
  const { refreshedSelection } = await import('../src/file-browser.mjs')
  const previous = { path: '/demo', entries: [{ id: 'old', name: 'keep', type: 'file' }, { id: 'gone', name: 'deleted', type: 'file' }, { id: 'changed', name: 'directory-now', type: 'file' }] }
  const next = { path: '/demo', entries: [{ id: 'new', name: 'keep', type: 'file' }, { id: 'dir', name: 'directory-now', type: 'directory' }] }
  assert.deepEqual([...refreshedSelection(previous, next, new Set(['old', 'gone', 'changed']))], ['new'])
  assert.equal(refreshedSelection(previous, { ...next, path: '/another' }, new Set(['old'])).size, 0)
})

test('shift selection covers visible files in both directions and cannot exceed upload limit', async () => {
  const { selectFileRange } = await import('../src/file-browser.mjs')
  const entries = [{ id: 'a', type: 'file' }, { id: 'folder', type: 'directory' }, { id: 'b', type: 'file' }, { id: 'c', type: 'file' }]
  assert.deepEqual([...selectFileRange(entries, new Set(), 'a', 'c', true, true)], ['a', 'b', 'c'])
  assert.deepEqual([...selectFileRange(entries, new Set(['a', 'b', 'c']), 'c', 'b', false, true)], ['a'])
  const selected = new Set(Array.from({ length: 100 }, (_, i) => `other${i}`))
  assert.equal(selectFileRange(entries, selected, null, 'a', true), selected)
  assert.deepEqual([...selectFileRange(entries, new Set(['hidden']), 'missing', 'b', true, true)], ['hidden', 'b'])
})
