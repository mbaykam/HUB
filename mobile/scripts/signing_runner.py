"""Manual signing on an ephemeral macOS runner; no public private artifacts.

This entry point is intentionally unusable until the owner enables a protected
GitHub environment and supplies existing signing material there. It never asks
Apple to create identifiers, profiles, certificates or accounts.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import signal
import ssl
import subprocess
import sys
import tempfile
import urllib.request

from signing_policy import SigningError, require, invocation, protected_environment, profiles, export_options


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise SigningError("Environment verification redirected unexpectedly.")


def verify_environment():
    request = urllib.request.Request("https://api.github.com/repos/mbaykam/HUB/environments/ios-signing", headers={
        "Authorization": "Bearer " + os.environ.get("GITHUB_TOKEN", ""),
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
        data = response.read(1_000_001)
        require(len(data) <= 1_000_000, "Environment response exceeds its bound.")
        protected_environment(json.loads(data))


def secret_file(folder, name, key, limit=10_000_000):
    encoded = os.environ.get(key, "")
    require(0 < len(encoded) <= limit * 2, "A required signing secret is missing or oversized.")
    data = base64.b64decode(encoded, validate=True)
    require(0 < len(data) <= limit, "A signing file exceeds its bound.")
    path = folder / name
    with path.open("xb") as output:
        output.write(data)
    path.chmod(0o600)
    return path


def execute(mode):
    require(sys.platform == "darwin", "Signing requires the isolated macOS runner.")
    verify_environment()  # Before reading/decoding any signing secret.
    root = Path(__file__).resolve().parents[1]
    bundle = json.loads((root / "capacitor.config.json").read_text())["appId"]
    team = os.environ.get("IOS_TEAM_ID", "")
    require(re.fullmatch(r"[A-Z0-9]{10}", team), "Configure the signing team.")
    password = os.environ.get("IOS_DISTRIBUTION_P12_PASSWORD", "")
    require(0 < len(password) <= 4096 and "\0" not in password, "Configure the existing certificate password.")
    # Do not expose signing secrets to build scripts or subprocess environments.
    child_env = {key: value for key, value in os.environ.items() if key in
                 {"PATH", "HOME", "TMPDIR", "DEVELOPER_DIR", "LANG", "LC_ALL"}}
    with tempfile.TemporaryDirectory(prefix="hub-ios-sign-") as private:
        folder = Path(private); folder.chmod(0o700)
        keychain = folder / "signing.keychain-db"
        keychain_password = secrets.token_urlsafe(40)  # Temporary local lock, not an Apple key.
        installed = []
        previous_search = None
        created_keychain = False
        with (folder / "private-build.log").open("wb") as log:
            def run(args, capture=False, timeout=180, env=None, merge=False):
                result = subprocess.run([str(arg) for arg in args], cwd=root, env=env or child_env,
                                        stdout=subprocess.PIPE if capture else log, stderr=subprocess.STDOUT if capture and merge else log,
                                        timeout=timeout, check=False)
                require(result.returncode == 0, "A signing command failed; no private command output was published.")
                return result.stdout or b""
            try:
                help_text = run(["xcodebuild", "-help"], True, merge=True).decode("utf-8", "replace")
                require("app-store-connect" in help_text, "The runner lacks the expected App Store export mode.")
                p12 = secret_file(folder, "identity.p12", "IOS_DISTRIBUTION_P12_BASE64")
                run(["security", "create-keychain", "-p", keychain_password, keychain]); created_keychain = True
                run(["security", "set-keychain-settings", "-lut", "21600", keychain])
                run(["security", "unlock-keychain", "-p", keychain_password, keychain])
                run(["security", "import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"])
                run(["security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychain_password, keychain])
                previous_search = shlex.split(run(["security", "list-keychains", "-d", "user"], True).decode())
                run(["security", "list-keychains", "-d", "user", "-s", keychain, *previous_search])
                identities = run(["security", "find-identity", "-v", "-p", "codesigning", keychain], True).decode()
                matches = re.findall(r'([0-9A-F]{40}) "(?:Apple Distribution|iPhone Distribution):[^"\n]+\(' + team + r'\)"', identities)
                require(len(matches) == 1, "Import exactly one valid Apple distribution identity for the configured team.")
                identity = matches[0]
                certificates = run(["security", "find-certificate", "-a", "-p", keychain], True).decode()
                pem = next((cert for cert in re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", certificates, re.S)
                            if hashlib.sha1(ssl.PEM_cert_to_DER_cert(cert)).hexdigest().upper() == identity), None)
                require(pem is not None, "The signing certificate was not found.")
                certificate = folder / "certificate.pem"; certificate.write_text(pem); certificate.chmod(0o600)
                run(["openssl", "x509", "-in", certificate, "-noout", "-checkend", "3600"])
                records = {}; originals = {}
                for target in ("app", "widget", "share"):
                    source = secret_file(folder, target + ".mobileprovision", "IOS_PROFILE_" + target.upper() + "_BASE64")
                    records[target] = plistlib.loads(run(["security", "cms", "-D", "-i", source], True))
                    originals[target] = source.read_bytes()
                mapping = profiles(records, team, bundle, identity)
                profile_dir = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
                profile_dir.mkdir(parents=True, exist_ok=True)
                for target, record in records.items():
                    destination = profile_dir / (record["UUID"] + ".mobileprovision")
                    with destination.open("xb") as output:  # Never replace a runner's existing profile.
                        installed.append((destination, os.fstat(output.fileno()).st_ino))
                        destination.chmod(0o600)
                        output.write(originals[target])
                archive = folder / "HUB.xcarchive"
                run(["xcodebuild", "-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Release",
                     "-destination", "generic/platform=iOS", "-archivePath", archive, "-derivedDataPath", folder / "DerivedData",
                     "CODE_SIGN_STYLE=Manual", "DEVELOPMENT_TEAM=" + team, "CODE_SIGN_IDENTITY=" + identity,
                     "HUB_APP_PROFILE=" + mapping[bundle], "HUB_WIDGET_PROFILE=" + mapping[bundle + ".voice-widget"],
                     "HUB_SHARE_PROFILE=" + mapping[bundle + ".share"], "HUB_PUSH_ENVIRONMENT=production",
                     "CURRENT_PROJECT_VERSION=" + os.environ["BUILD_NUMBER"], "archive"], timeout=1500)
                app = archive / "Products/Applications/App.app"
                run(["codesign", "--verify", "--deep", "--strict", app])
                info = plistlib.loads((app / "Info.plist").read_bytes())
                require(info["CFBundleIdentifier"] == bundle and str(info["CFBundleVersion"]) == os.environ["BUILD_NUMBER"], "Archive identity/version mismatch.")
                for name, suffix in (("HubVoiceWidget", ".voice-widget"), ("HubShareExtension", ".share")):
                    extension = plistlib.loads((app / "PlugIns" / (name + ".appex") / "Info.plist").read_bytes())
                    require(extension["CFBundleIdentifier"] == bundle + suffix and str(extension["CFBundleVersion"]) == os.environ["BUILD_NUMBER"], "Extension identity/version mismatch.")
                options = folder / "ExportOptions.plist"
                options.write_bytes(plistlib.dumps(export_options(team, mapping, identity)))
                exported = folder / "Export"
                run(["xcodebuild", "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", options, "-exportPath", exported], timeout=900)
                ipas = list(exported.glob("*.ipa")); require(len(ipas) == 1, "Expected one exported iPhone package.")
                if mode == "testflight":
                    key_id, issuer, app_id = (os.environ.get(name, "") for name in ("IOS_ASC_KEY_ID", "IOS_ASC_ISSUER_ID", "IOS_ASC_APP_ID"))
                    require(re.fullmatch(r"[A-Z0-9]{10}", key_id) and re.fullmatch(r"[0-9A-Fa-f-]{36}", issuer) and re.fullmatch(r"[1-9][0-9]{0,19}", app_id), "Configure existing App Store Connect API/app identifiers.")
                    keys = folder / "api-keys"; keys.mkdir(mode=0o700)
                    secret_file(keys, "AuthKey_" + key_id + ".p8", "IOS_ASC_PRIVATE_KEY_P8_BASE64", 100_000)
                    upload_env = {**child_env, "API_PRIVATE_KEYS_DIR": str(keys)}
                    upload_help = run(["xcrun", "altool", "--help"], True, merge=True).decode("utf-8", "replace")
                    require(all(flag in upload_help for flag in ("--upload-package", "--apiKey", "--apiIssuer")), "Review the runner's current upload CLI before proceeding.")
                    args = ["xcrun", "altool", "--upload-package", ipas[0], "-t", "ios", "--apple-id", app_id,
                            "--bundle-id", bundle, "--bundle-short-version-string", str(info["CFBundleShortVersionString"]),
                            "--bundle-version", str(info["CFBundleVersion"]), "--apiKey", key_id, "--apiIssuer", issuer, "--output-format", "json"]
                    provider = os.environ.get("IOS_ASC_PROVIDER_PUBLIC_ID", "")
                    if provider:
                        require(re.fullmatch(r"[A-Za-z0-9-]{1,80}", provider), "Invalid provider identifier.")
                        args += ["--asc-public-id", provider]
                    run(args, timeout=1500, env=upload_env)  # One explicit upload; never retry automatically.
                    print("Upload accepted by the command. Apple processing and phone acceptance remain separate.")
                else:
                    print("Archive/export checks passed. Private signed files will be removed, not published.")
            finally:
                cleanup_ok = True
                if previous_search is not None:
                    try: run(["security", "list-keychains", "-d", "user", "-s", *previous_search])
                    except Exception: cleanup_ok = False
                if created_keychain:
                    try: run(["security", "delete-keychain", keychain])
                    except Exception: cleanup_ok = False
                for path, inode in installed:
                    try:
                        require(path.lstat().st_ino == inode and not path.is_symlink(), "A temporary profile changed unexpectedly.")
                        path.unlink()
                    except Exception: cleanup_ok = False
                require(cleanup_ok, "Temporary signing cleanup could not be confirmed.")


def main():
    mode = invocation(os.environ)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    execute(mode)


if __name__ == "__main__":
    try:
        main()
    except SigningError as error:
        print(str(error), file=sys.stderr); sys.exit(1)
    except Exception:
        print("Signing stopped. Private credential, profile and build output was withheld.", file=sys.stderr); sys.exit(1)
