// Label bands for proof-matrix.sh's matrix-contact.png. CoreGraphics + CoreText only (no packages), because the
// ffmpeg here has no drawtext. usage: swift label.swift <out.png> <width> <line1> <line2> <PASS|FAIL|ERROR> [more groups of five]
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 5, args.count % 5 == 0 else {
    FileHandle.standardError.write(Data("usage: label.swift <out.png> <width> <line1> <line2> <status> ...\n".utf8))
    exit(1)
}
let height = 72
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func draw(_ text: String, size: CGFloat, bold: Bool, color: CGColor, at point: CGPoint, in ctx: CGContext) {
    let font = CTFontCreateWithName((bold ? "HelveticaNeue-Bold" : "HelveticaNeue") as CFString, size, nil)
    let attrs: [NSAttributedString.Key: Any] = [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ]
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    ctx.textPosition = point
    CTLineDraw(line, ctx)
}

var i = 0
while i < args.count {
    let out = args[i], width = Int(args[i + 1]) ?? 600, l1 = args[i + 2], l2 = args[i + 3], status = args[i + 4]
    i += 5
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
    ctx.setFillColor(CGColor(srgbRed: 0.07, green: 0.08, blue: 0.10, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let chip: CGColor = status == "PASS" ? CGColor(srgbRed: 0.20, green: 0.72, blue: 0.40, alpha: 1)
        : status == "FAIL" ? CGColor(srgbRed: 0.90, green: 0.25, blue: 0.25, alpha: 1)
        : CGColor(srgbRed: 0.95, green: 0.65, blue: 0.15, alpha: 1)
    ctx.setFillColor(chip)
    ctx.fill(CGRect(x: 0, y: 0, width: 8, height: height))
    let white = CGColor(srgbRed: 0.95, green: 0.96, blue: 0.98, alpha: 1)
    draw(l1, size: 24, bold: true, color: white, at: CGPoint(x: 22, y: 38), in: ctx)
    draw(status, size: 24, bold: true, color: chip, at: CGPoint(x: CGFloat(width) - 22 - 70, y: 38), in: ctx)
    draw(l2, size: 15, bold: false, color: CGColor(srgbRed: 0.70, green: 0.74, blue: 0.80, alpha: 1), at: CGPoint(x: 22, y: 12), in: ctx)
    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { exit(1) }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { exit(1) }
}
