"""Account-free Release archive proof, never signing/export/TestFlight proof."""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys


def inspect_archive(archive, bundle, source=None):
    archive = Path(archive)
    app = archive / "Products/Applications/App.app"
    if app.is_symlink() or not app.resolve().is_relative_to(archive.resolve()):
        raise ValueError("Archive app leaves its owned directory")
    info = plistlib.loads((app / "Info.plist").read_bytes())
    metadata = plistlib.loads((archive / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != bundle or info.get("CFBundleSupportedPlatforms") != ["iPhoneOS"]:
        raise ValueError("Archive platform/identifier mismatch")
    if not str(info.get("DTSDKName", "")).startswith("iphoneos27."):
        raise ValueError("The actual capture-capable iPhone SDK is required")
    if metadata.get("ApplicationProperties", {}).get("SigningIdentity"):
        raise ValueError("A signed archive cannot enter the public unsigned evidence path")
    for path in app.rglob("*"):
        if path.is_symlink():
            if not path.resolve().is_relative_to(app.resolve()):
                raise ValueError("Archive symlink leaves the app")
        if path.name == "embedded.mobileprovision" or path.suffix.lower() in (".p12", ".p8", ".key"):
            raise ValueError("Private signing material cannot enter a public artifact")
    for name, suffix in (("HubVoiceWidget", ".voice-widget"), ("HubShareExtension", ".share")):
        extension = plistlib.loads((app / "PlugIns" / (name + ".appex") / "Info.plist").read_bytes())
        if extension.get("CFBundleIdentifier") != bundle + suffix or extension.get("CFBundleVersion") != info.get("CFBundleVersion"):
            raise ValueError("Archive extension identity/version mismatch")
    if source is not None and not re.fullmatch(r"[0-9a-f]{40}", source):
        raise ValueError("Invalid archive source identity")
    return {"version": 1, "source": source, "configuration": "Release", "archive": True,
            "bundleId": bundle, "sdk": info["DTSDKName"], "minimumOS": info.get("MinimumOSVersion"),
            "signedIPhoneDelivery": False, "physicalAcceptance": False, "testFlightUpload": False}


def main():
    if sys.platform != "darwin":
        raise RuntimeError("Use the manual xcode-27 unsigned iPhone workflow")
    root = Path(__file__).resolve().parents[1]
    build = root / "build"; build.mkdir(exist_ok=True)
    archive = build / "HUBUnsigned.xcarchive"
    zipped = build / "HUB-ios-device-unsigned.zip"
    proof = build / "unsigned-device-proof.json"
    if any(path.exists() for path in (archive, zipped, proof)):
        raise RuntimeError("Use a clean build workspace; existing artifacts are not overwritten")
    subprocess.run(["xcodebuild", "-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Release",
                    "-destination", "generic/platform=iOS", "-archivePath", str(archive),
                    "-derivedDataPath", "build/ReleaseDerivedData", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "archive"], cwd=root, check=True)
    bundle = json.loads((root / "capacitor.config.json").read_text())["appId"]
    report = inspect_archive(archive, bundle, os.environ.get("GITHUB_SHA"))
    subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(archive / "Products/Applications/App.app"), str(zipped)], check=True)
    proof.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
