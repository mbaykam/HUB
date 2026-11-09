// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HubNative",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "HubNative", targets: ["HubNative"])],
    targets: [
        .target(name: "HubNative"),
        .testTarget(name: "HubNativeTests", dependencies: ["HubNative"])
    ]
)
