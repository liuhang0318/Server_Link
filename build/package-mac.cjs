'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const projectDirectory = path.resolve(__dirname, '..')
const packageInfo = require('../package.json')
const productName = packageInfo.build.productName
const releaseDirectory = path.join(projectDirectory, packageInfo.build.directories.output)
const appOutputDirectory = path.join(releaseDirectory, 'mac-arm64')
const appPath = path.join(appOutputDirectory, `${productName}.app`)
const applicationsLink = path.join(appOutputDirectory, 'Applications')
const dmgName = `${productName}-${packageInfo.version}-arm64.dmg`
const dmgPath = path.join(releaseDirectory, dmgName)

function run (file, args) {
  execFileSync(file, args, {
    cwd: projectDirectory,
    stdio: 'inherit'
  })
}

async function removeOldApplicationsLink () {
  try {
    const stat = await fs.lstat(applicationsLink)
    if (!stat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink: ${applicationsLink}`)
    }
    await fs.unlink(applicationsLink)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** 只删除发布目录中的旧版 arm64 安装盘及校验文件，不遍历或跟随符号链接。 */
async function removeOlderPackages (directory, currentVersion) {
  const current = currentVersion.split('.').map(Number)
  if (!/^\d+\.\d+\.\d+$/u.test(currentVersion)) throw new Error('invalid release version')
  const removed = []
  for (const folder of [directory, path.join(directory, 'obsolete')]) {
    try {
      if (!(await fs.lstat(folder)).isDirectory()) continue
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const match = /^ServerLink-(\d+)\.(\d+)\.(\d+)-arm64\.dmg(?:\.sha256)?$/u.exec(entry.name)
      if (!entry.isFile() || !match) continue
      const version = match.slice(1).map(Number)
      const difference = version.map((number, index) => number - current[index]).find(number => number !== 0)
      if (!(difference < 0)) continue
      const file = path.join(folder, entry.name)
      // 调用方仅在新安装盘和签名校验通过后执行，防止构建失败时丢失可用旧包。
      await fs.unlink(file)
      removed.push(file)
    }
  }
  return removed
}

/** Packages and verifies the arm64 app before retiring older installers. */
async function packageMac () {
  const builder = path.join(projectDirectory, 'node_modules', 'electron-builder', 'cli.js')
  run(process.execPath, [builder, '--mac', 'dir', '--arm64'])

  await fs.access(appPath)
  await removeOldApplicationsLink()
  // The temporary Finder target is removed after imaging and never becomes app data.
  await fs.symlink('/Applications', applicationsLink)
  try {
    run('/usr/bin/hdiutil', [
      'create',
      '-volname', productName,
      '-srcfolder', appOutputDirectory,
      '-ov',
      '-format', 'UDZO',
      dmgPath
    ])
  } finally {
    await removeOldApplicationsLink()
  }

  const digest = createHash('sha256').update(await fs.readFile(dmgPath)).digest('hex')
  await fs.writeFile(`${dmgPath}.sha256`, `${digest}  ${dmgName}\n`, 'utf8')
  // 新包校验失败会抛出异常，旧包清理不会执行。
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  run('/usr/bin/hdiutil', ['verify', dmgPath])
  const removed = await removeOlderPackages(releaseDirectory, packageInfo.version)
  for (const file of removed) console.log(`Removed old installer: ${file}`)
  console.log(`Created ${dmgPath}`)
}

if (require.main === module) {
  packageMac().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { removeOlderPackages }
