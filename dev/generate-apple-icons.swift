#!/usr/bin/env xcrun swift

import AppKit
import CoreGraphics
import Foundation

enum BackgroundStyle {
  case solidWhite
  case roundedWhite(cornerRadius: CGFloat)
}

struct AppleIconComposer {
  let sourceURL: URL
  let macOutputURL: URL
  let iosOutputURL: URL

  private let canvasSize: CGFloat = 1024
  private let macVisibleFraction: CGFloat = 0.66
  private let iosVisibleFraction: CGFloat = 0.70
  private let macCornerRadius: CGFloat = 235
  private let alphaThreshold: CGFloat = 0.01

  func run() throws {
    guard
      let sourceImage = NSImage(contentsOf: sourceURL),
      let sourceTIFF = sourceImage.tiffRepresentation,
      let sourceBitmap = NSBitmapImageRep(data: sourceTIFF)
    else {
      throw NSError(
        domain: "AppleIconComposer",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Unable to load source image at \(sourceURL.path)"]
      )
    }

    guard let visibleBounds = alphaBounds(in: sourceBitmap) else {
      throw NSError(
        domain: "AppleIconComposer",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Source image does not contain visible pixels"]
      )
    }

    try render(
      sourceImage: sourceImage,
      sourceBitmap: sourceBitmap,
      visibleBounds: visibleBounds,
      outputURL: macOutputURL,
      hasAlpha: true,
      visibleFraction: macVisibleFraction,
      background: .roundedWhite(cornerRadius: macCornerRadius)
    )

    try render(
      sourceImage: sourceImage,
      sourceBitmap: sourceBitmap,
      visibleBounds: visibleBounds,
      outputURL: iosOutputURL,
      hasAlpha: false,
      visibleFraction: iosVisibleFraction,
      background: .solidWhite
    )
  }

  private func alphaBounds(in bitmap: NSBitmapImageRep) -> CGRect? {
    let width = bitmap.pixelsWide
    let height = bitmap.pixelsHigh

    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1

    for y in 0..<height {
      for x in 0..<width {
        guard let color = bitmap.colorAt(x: x, y: y) else {
          continue
        }

        if color.alphaComponent > alphaThreshold {
          minX = min(minX, x)
          minY = min(minY, y)
          maxX = max(maxX, x)
          maxY = max(maxY, y)
        }
      }
    }

    guard maxX >= minX, maxY >= minY else {
      return nil
    }

    return CGRect(
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1
    )
  }

  private func render(
    sourceImage: NSImage,
    sourceBitmap: NSBitmapImageRep,
    visibleBounds: CGRect,
    outputURL: URL,
    hasAlpha: Bool,
    visibleFraction: CGFloat,
    background: BackgroundStyle
  ) throws {
    let pixels = Int(canvasSize)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = hasAlpha
      ? CGImageAlphaInfo.premultipliedLast.rawValue
      : CGImageAlphaInfo.noneSkipLast.rawValue

    guard
      let cgContext = CGContext(
        data: nil,
        width: pixels,
        height: pixels,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: bitmapInfo
      )
    else {
      throw NSError(
        domain: "AppleIconComposer",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Unable to create output bitmap context"]
      )
    }

    cgContext.interpolationQuality = .high

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: cgContext, flipped: false)

    if hasAlpha {
      cgContext.clear(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))
    }

    NSColor.white.setFill()
    switch background {
    case .solidWhite:
      NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)).fill()
    case let .roundedWhite(cornerRadius):
      NSBezierPath(
        roundedRect: NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize),
        xRadius: cornerRadius,
        yRadius: cornerRadius
      ).fill()
    }

    let drawRect = scaledDrawRect(
      sourceBitmap: sourceBitmap,
      visibleBounds: visibleBounds,
      visibleFraction: visibleFraction
    )

    sourceImage.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()

    guard
      let outputImage = cgContext.makeImage(),
      let pngData = NSBitmapImageRep(cgImage: outputImage).representation(using: .png, properties: [:])
    else {
      throw NSError(
        domain: "AppleIconComposer",
        code: 5,
        userInfo: [NSLocalizedDescriptionKey: "Unable to encode output PNG"]
      )
    }

    try pngData.write(to: outputURL)
  }

  private func scaledDrawRect(
    sourceBitmap: NSBitmapImageRep,
    visibleBounds: CGRect,
    visibleFraction: CGFloat
  ) -> NSRect {
    let sourceWidth = CGFloat(sourceBitmap.pixelsWide)
    let sourceHeight = CGFloat(sourceBitmap.pixelsHigh)
    let visibleTarget = canvasSize * visibleFraction
    let scale = min(visibleTarget / visibleBounds.width, visibleTarget / visibleBounds.height)

    let drawSize = NSSize(width: sourceWidth * scale, height: sourceHeight * scale)
    let sourceCenter = CGPoint(x: sourceWidth / 2, y: sourceHeight / 2)
    let visibleCenter = CGPoint(x: visibleBounds.midX, y: visibleBounds.midY)
    let centeringOffset = CGPoint(
      x: (sourceCenter.x - visibleCenter.x) * scale,
      y: (sourceCenter.y - visibleCenter.y) * scale
    )

    return NSRect(
      x: (canvasSize - drawSize.width) / 2 + centeringOffset.x,
      y: (canvasSize - drawSize.height) / 2 + centeringOffset.y,
      width: drawSize.width,
      height: drawSize.height
    )
  }
}

guard CommandLine.arguments.count == 4 else {
  fputs(
    "Usage: generate-apple-icons.swift <source-transparent-png> <mac-master-png> <ios-master-png>\n",
    stderr
  )
  exit(1)
}

let composer = AppleIconComposer(
  sourceURL: URL(fileURLWithPath: CommandLine.arguments[1]),
  macOutputURL: URL(fileURLWithPath: CommandLine.arguments[2]),
  iosOutputURL: URL(fileURLWithPath: CommandLine.arguments[3])
)

do {
  try composer.run()
} catch {
  fputs("\(error.localizedDescription)\n", stderr)
  exit(1)
}
