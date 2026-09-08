'use strict'

const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const run = promisify(execFile)
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'
const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription'
]

async function editPlist (plistPath, command, ignoreMissing = false) {
  try {
    await run(PLIST_BUDDY, ['-c', command, plistPath])
  } catch (error) {
    if (!ignoreMissing) throw error
  }
}

/**
 * Removes Electron's generic device permission descriptions and permissive
 * network exception before electron-builder flips fuses and signs the bundle.
 */
module.exports = async function hardenMacInfoPlist (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const plistPath = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Info.plist')

  for (const key of UNUSED_PERMISSION_KEYS) {
    await editPlist(plistPath, `Delete :${key}`, true)
  }

  // The app renders only bundled files. Native OpenSSH and direct SSH2 TCP do
  // not require a WebView ATS bypass, so arbitrary URL loading stays disabled.
  await editPlist(plistPath, 'Delete :NSAppTransportSecurity', true)
  await editPlist(plistPath, 'Add :NSAppTransportSecurity dict')
  await editPlist(plistPath, 'Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false')
}
