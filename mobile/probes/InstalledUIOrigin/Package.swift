// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "InstalledUIOrigin",
    platforms: [.macOS(.v12)],
    targets: [.testTarget(name: "InstalledUIOriginTests")]
)
