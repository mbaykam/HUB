#!/usr/bin/env python3
"""Generate a disposable, dependency-free iOS app/XCTest UI project on a Mac."""
import argparse
import hashlib
import json
from pathlib import Path


def identifier(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()


def quote(value):
    return json.dumps(str(value))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    production = source.parent.parent / "native/Sources/HubNative/HubWebView.swift"
    if not production.is_file():
        raise SystemExit("Production HubWebView.swift not found")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    project = output / "KeyboardAccessory.xcodeproj"
    schemes = project / "xcshareddata/xcschemes"
    schemes.mkdir(parents=True, exist_ok=True)
    objects = []

    def obj(name, body):
        objects.append(f"{identifier(name)} = {{ {body} }};")
        return identifier(name)

    def refs(names):
        return "(" + ",".join(identifier(name) for name in names) + ",)"

    files = {"app-source": source / "AppDelegate.swift", "production-source": production,
             "test-source": source / "KeyboardAccessoryUITests.swift"}
    for name, path in files.items():
        obj(name, f"isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {quote(path)}; sourceTree = \"<absolute>\";")
        obj(name + "-build", f"isa = PBXBuildFile; fileRef = {identifier(name)};")
    obj("app-product", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = KeyboardAccessory.app; sourceTree = BUILT_PRODUCTS_DIR;')
    obj("test-product", 'isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = KeyboardAccessoryUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
    obj("products", f"isa = PBXGroup; children = {refs(['app-product', 'test-product'])}; name = Products; sourceTree = \"<group>\";")
    obj("main-group", f"isa = PBXGroup; children = {refs(list(files) + ['products'])}; sourceTree = \"<group>\";")
    obj("app-sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(['app-source-build','production-source-build'])}; runOnlyForDeploymentPostprocessing = 0;")
    obj("test-sources", f"isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = {refs(['test-source-build'])}; runOnlyForDeploymentPostprocessing = 0;")
    for name in ("app-frameworks", "test-frameworks"):
        obj(name, "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
    obj("app-proxy", f"isa = PBXContainerItemProxy; containerPortal = {identifier('project')}; proxyType = 1; remoteGlobalIDString = {identifier('app-target')}; remoteInfo = KeyboardAccessory;")
    obj("app-dependency", f"isa = PBXTargetDependency; target = {identifier('app-target')}; targetProxy = {identifier('app-proxy')};")
    common = {"SDKROOT": "iphoneos", "IPHONEOS_DEPLOYMENT_TARGET": "15.0", "SWIFT_VERSION": "5.0",
              "TARGETED_DEVICE_FAMILY": "1", "CODE_SIGNING_ALLOWED": "NO", "GENERATE_INFOPLIST_FILE": "YES",
              "CLANG_ENABLE_MODULES": "YES", "SWIFT_OPTIMIZATION_LEVEL": "-Onone", "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym"}
    for target in ("project", "app", "test"):
        settings = dict(common)
        if target == "app":
            settings.update(PRODUCT_NAME="KeyboardAccessory", PRODUCT_BUNDLE_IDENTIFIER="dev.hub.probe.KeyboardAccessory",
                            INFOPLIST_KEY_UILaunchScreen_Generation="YES", INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents="YES", INFOPLIST_KEY_UIApplicationSceneManifest_Generation="YES")
        elif target == "test":
            settings.update(PRODUCT_NAME="KeyboardAccessoryUITests", PRODUCT_BUNDLE_IDENTIFIER="dev.hub.probe.KeyboardAccessoryUITests",
                            TEST_TARGET_NAME="KeyboardAccessory")
        body = " ".join(f"{key} = {quote(value)};" for key, value in settings.items())
        for config in ("Debug", "Release"):
            obj(target + config, f"isa = XCBuildConfiguration; buildSettings = {{ {body} }}; name = {config};")
        obj(target + "-configs", f"isa = XCConfigurationList; buildConfigurations = {refs([target+'Debug',target+'Release'])}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug;")
    obj("app-target", f"isa = PBXNativeTarget; buildConfigurationList = {identifier('app-configs')}; buildPhases = {refs(['app-sources','app-frameworks'])}; buildRules = (); dependencies = (); name = KeyboardAccessory; productName = KeyboardAccessory; productReference = {identifier('app-product')}; productType = \"com.apple.product-type.application\";")
    obj("test-target", f"isa = PBXNativeTarget; buildConfigurationList = {identifier('test-configs')}; buildPhases = {refs(['test-sources','test-frameworks'])}; buildRules = (); dependencies = {refs(['app-dependency'])}; name = KeyboardAccessoryUITests; productName = KeyboardAccessoryUITests; productReference = {identifier('test-product')}; productType = \"com.apple.product-type.bundle.ui-testing\";")
    obj("project", f"isa = PBXProject; attributes = {{ LastUpgradeCheck = 1600; TargetAttributes = {{ {identifier('test-target')} = {{ TestTargetID = {identifier('app-target')}; }}; }}; }}; buildConfigurationList = {identifier('project-configs')}; compatibilityVersion = \"Xcode 14.0\"; developmentRegion = en; knownRegions = (en,tr,Base); mainGroup = {identifier('main-group')}; productRefGroup = {identifier('products')}; projectDirPath = \"\"; projectRoot = \"\"; targets = {refs(['app-target','test-target'])};")
    (project / "project.pbxproj").write_text("// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n" + "\n".join(objects) + f"\n}}; rootObject = {identifier('project')}; }}\n")
    def reference(target, product):
        return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{identifier(target)}" BuildableName="{product}" BlueprintName="{product.split(".")[0]}" ReferencedContainer="container:KeyboardAccessory.xcodeproj"/>'
    app_ref = reference("app-target", "KeyboardAccessory.app")
    test_ref = reference("test-target", "KeyboardAccessoryUITests.xctest")
    (schemes / "KeyboardAccessory.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{app_ref}</BuildActionEntry><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">{test_ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">{test_ref}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></LaunchAction>
</Scheme>
''')
    print(project)


if __name__ == "__main__":
    main()
