'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const css = readFileSync(path.join(__dirname, '../src/style.css'), 'utf8')
const html = readFileSync(path.join(__dirname, '../index.html'), 'utf8')

/** 仅锁定源码中的布局约束；真实窗口的尺寸和视觉效果仍需浏览器验证。 */
function rules (selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]+)\\}`, 'g'))].map(match => match[1]).join('\n')
}

test('workspace bounds the tab track independently of the fixed session controls', () => {
  assert.match(rules('.workspace'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  assert.match(rules('.topbar'), /grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+auto/)
  assert.match(rules('.tab-strip'), /grid-template-columns:\s*26px\s+minmax\(0,\s*1fr\)\s+26px/)
  for (const selector of ['.workspace', '.topbar', '.tab-strip', '.session-tabs']) {
    assert.match(rules(selector), /min-width:\s*0(?:;|\s*$)/, selector)
  }
  assert.match(rules('.session-tabs'), /overflow-x:\s*auto/)
  // 拖动插入点依赖标签容器的 offsetLeft 坐标，不能把定位上下文挪到外层。
  assert.match(rules('.session-tabs'), /position:\s*relative/)
  assert.match(rules('.session-actions'), /flex-shrink:\s*0/)
  assert.match(rules('.sidebar-hidden .topbar'), /padding-left:\s*88px/)
})

test('tab navigation stays outside the scroll area and icon-only actions retain accessible names', () => {
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'))
  assert.match(header, /id="tabs-scroll-left"[\s\S]*?<div id="session-tabs"[^>]*><\/div>[\s\S]*?id="tabs-scroll-right"[\s\S]*?<\/div>\s*<div class="session-actions">/)
  assert.match(header, /id="session-tabs"[^>]*role="tablist"[^>]*aria-label="[^"]+"/)
  for (const id of ['tabs-scroll-left', 'tabs-scroll-right', 'reconnect-session', 'close-session']) {
    const button = header.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`))?.[0]
    assert.ok(button, id)
    assert.match(button, /type="button"/, id)
    assert.match(button, /aria-label="[^"]+"/, id)
    assert.match(button, /title="[^"]+"/, id)
  }
  assert.match(css, /@media\s*\(max-width:\s*1050px\)/)
  assert.match(rules('.session-actions .action-label'), /display:\s*none/)
})

test('long tab and SFTP titles truncate without shrinking the pane close button', () => {
  for (const selector of ['.tab-label', '.sftp-heading > div']) {
    assert.match(rules(selector), /min-width:\s*0/, selector)
  }
  for (const selector of ['.tab-label', '.file-pane .sftp-heading h2']) {
    const rule = rules(selector)
    assert.match(rule, /overflow:\s*hidden/, selector)
    assert.match(rule, /text-overflow:\s*ellipsis/, selector)
    assert.match(rule, /white-space:\s*nowrap/, selector)
  }
  assert.match(rules('.file-pane .sftp-heading h2'), /max-width:\s*100%/)
  assert.match(rules('.sftp-heading > button'), /flex-shrink:\s*0/)
})

test('card styling preserves fixed drag ghosts, file overflow and the immediate terminal overlay', () => {
  // 拖影同时具有两个类；组合选择器避免普通标签的新定位规则把它拉回文档流。
  assert.match(rules('.session-tab.tab-ghost'), /position:\s*fixed/)
  assert.match(rules('.session-tab.tab-ghost'), /pointer-events:\s*none/)
  assert.match(rules('.file-columns'), /overflow-x:\s*auto/)
  assert.match(rules('.file-columns .file-pane'), /flex:\s*0\s+0\s+auto/)
  assert.match(rules('.file-pane .sftp-table, .file-pane .local-table'), /min-width:\s*760px/)
  assert.match(rules('.terminal-typeahead'), /transition:\s*none\s*!important/)
  assert.match(rules('.terminal-typeahead'), /animation:\s*none\s*!important/)
  assert.match(html, /id="sidebar-toggle"[^>]*aria-controls="server-sidebar"/)
})
