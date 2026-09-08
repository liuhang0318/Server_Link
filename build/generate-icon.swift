import AppKit
import Foundation

private let canvasSize: CGFloat = 1024
private let variants: [(name: String, pixels: Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024),
]

private func color(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha
  )
}

/// 保留原始 Link Prompt 图形，不绘制外阴影或光晕，圆角外保持透明。
private func drawIcon() {
  let base = NSBezierPath(
    roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880),
    xRadius: 205,
    yRadius: 205
  )

  // 使用纯色底，避免深浅渐变被看成残留阴影。
  color(0x1d3630).setFill()
  base.fill()

  color(0xffffff, alpha: 0.10).setStroke()
  base.lineWidth = 5
  base.stroke()

  let chevron = NSBezierPath()
  chevron.move(to: NSPoint(x: 334, y: 330))
  chevron.line(to: NSPoint(x: 528, y: 512))
  chevron.line(to: NSPoint(x: 334, y: 694))
  chevron.lineWidth = 88
  chevron.lineCapStyle = .round
  chevron.lineJoinStyle = .round

  let cursor = NSBezierPath()
  cursor.move(to: NSPoint(x: 574, y: 332))
  cursor.line(to: NSPoint(x: 754, y: 332))
  cursor.lineWidth = 88
  cursor.lineCapStyle = .round

  color(0x7ee5c5).setStroke()
  chevron.stroke()
  color(0x59c4a4).setStroke()
  cursor.stroke()
}

/// Rasterizes each variant at its native pixel size so small Dock/Finder icons stay crisp.
private func renderPNG(pixels: Int) -> Data {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pixels,
    pixelsHigh: pixels,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create \(pixels)x\(pixels) icon bitmap")
  }

  let previousContext = NSGraphicsContext.current
  NSGraphicsContext.current = context
  context.cgContext.clear(CGRect(x: 0, y: 0, width: pixels, height: pixels))
  context.cgContext.setShouldAntialias(true)
  let scale = CGFloat(pixels) / canvasSize
  context.cgContext.scaleBy(x: scale, y: scale)
  drawIcon()
  context.flushGraphics()
  NSGraphicsContext.current = previousContext

  guard let data = bitmap.representation(
    using: NSBitmapImageRep.FileType.png,
    properties: [:]
  ) else {
    fatalError("Unable to encode \(pixels)x\(pixels) icon PNG")
  }
  return data
}

/// Rebuilds the standard iconset and asks macOS iconutil to validate and package it.
private func generateIcon() throws {
  let buildDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  let iconsetURL = buildDirectory.appendingPathComponent("icon.iconset", isDirectory: true)
  let icnsURL = buildDirectory.appendingPathComponent("icon.icns")
  let fileManager = FileManager.default

  // Remove only generated variants so a renamed or stale PNG cannot leak into the .icns.
  if fileManager.fileExists(atPath: iconsetURL.path) {
    try fileManager.removeItem(at: iconsetURL)
  }
  try fileManager.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

  for variant in variants {
    let outputURL = iconsetURL.appendingPathComponent(variant.name)
    try renderPNG(pixels: variant.pixels).write(to: outputURL, options: .atomic)
  }
  // 单独提供透明 PNG，启动时直接更新 Dock，避开系统对旧 icns 的缓存。
  try renderPNG(pixels: 512).write(to: buildDirectory.appendingPathComponent("dock-icon.png"), options: .atomic)

  // iconutil is the system authority for the required macOS icon names and dimensions.
  let iconutil = Process()
  iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  iconutil.arguments = ["--convert", "icns", "--output", icnsURL.path, iconsetURL.path]
  try iconutil.run()
  iconutil.waitUntilExit()
  guard iconutil.terminationStatus == 0 else {
    throw NSError(
      domain: "ServerLinkIconGenerator",
      code: Int(iconutil.terminationStatus),
      userInfo: [NSLocalizedDescriptionKey: "iconutil failed"]
    )
  }

  print("Generated \(icnsURL.path)")
}

do {
  try generateIcon()
} catch {
  fputs("ServerLink icon generation failed: \(error.localizedDescription)\n", stderr)
  exit(EXIT_FAILURE)
}
