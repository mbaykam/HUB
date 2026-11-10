import copy
import datetime as dt
import hashlib
import io
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from signing_policy import SigningError, invocation, protected_environment, profiles, export_options
import signing_runner
from archive_unsigned import inspect_archive

NOW = dt.datetime(2026, 11, 10, tzinfo=dt.timezone.utc)
TEAM, BUNDLE = "FIXTURE123", "com.example.fixture"
# Synthetic metadata, not a certificate/key or an Apple-signed provisioning file.
CERT = b"synthetic public certificate metadata only"
IDENTITY = hashlib.sha1(CERT).hexdigest().upper()


def metadata():
    result = {}
    for i, (name, suffix) in enumerate((("app", ""), ("widget", ".voice-widget"), ("share", ".share"))):
        entitlements = {"application-identifier": TEAM + "." + BUNDLE + suffix,
                        "com.apple.developer.team-identifier": TEAM, "get-task-allow": False}
        if name != "widget":
            entitlements["com.apple.security.application-groups"] = ["group." + BUNDLE]
        if name == "app":
            entitlements["aps-environment"] = "production"
        result[name] = {"UUID": f"00000000-0000-0000-0000-{i:012d}", "TeamIdentifier": [TEAM],
                        "ApplicationIdentifierPrefix": [TEAM], "Platform": ["iOS"],
                        "ExpirationDate": NOW + dt.timedelta(days=7), "Entitlements": entitlements,
                        "DeveloperCertificates": [CERT]}
    return result


class SigningPolicyTests(unittest.TestCase):
    def test_unsigned_archive_evidence_accepts_only_matching_iphone_release_contents(self):
        with tempfile.TemporaryDirectory(prefix="hub-eval-unsigned-archive-") as folder:
            archive = Path(folder); app = archive / "Products/Applications/App.app"
            app.mkdir(parents=True)
            (archive / "Info.plist").write_bytes(plistlib.dumps({"ApplicationProperties": {}}))
            info = {"CFBundleIdentifier": BUNDLE, "CFBundleVersion": "1", "CFBundleSupportedPlatforms": ["iPhoneOS"], "DTSDKName": "iphoneos27.1", "MinimumOSVersion": "15.0"}
            (app / "Info.plist").write_bytes(plistlib.dumps(info))
            for name, suffix in (("HubVoiceWidget", ".voice-widget"), ("HubShareExtension", ".share")):
                extension = app / "PlugIns" / (name + ".appex"); extension.mkdir(parents=True)
                (extension / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": BUNDLE + suffix, "CFBundleVersion": "1"}))
            proof = inspect_archive(archive, BUNDLE, "a" * 40)
            self.assertEqual(proof["configuration"], "Release"); self.assertFalse(proof["signedIPhoneDelivery"])
            for name in ("embedded.mobileprovision", "private.p8", "identity.p12"):
                candidate = app / name; candidate.write_bytes(b"synthetic forbidden metadata")
                with self.assertRaises(ValueError): inspect_archive(archive, BUNDLE)
                candidate.unlink()
            (archive / "Info.plist").write_bytes(plistlib.dumps({"ApplicationProperties": {"SigningIdentity": "synthetic identity"}}))
            with self.assertRaises(ValueError): inspect_archive(archive, BUNDLE)

    def test_default_and_untrusted_invocations_fail_closed(self):
        env = {"GITHUB_REPOSITORY": "mbaykam/HUB", "GITHUB_REF": "refs/heads/main",
               "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": "a" * 40,
               "GITHUB_WORKFLOW_REF": "mbaykam/HUB/.github/workflows/ios-signing.yml@refs/heads/main",
               "SIGNING_ENABLED": "true", "SIGNING_MODE": "archive", "SIGNING_CONFIRMATION": "ARCHIVE_ONLY", "BUILD_NUMBER": "123"}
        self.assertEqual(invocation(env), "archive")
        for key, value in [("GITHUB_REPOSITORY", "fork/HUB"), ("GITHUB_REF", "refs/pull/1/merge"), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_WORKFLOW_REF", "another-workflow"), ("SIGNING_ENABLED", ""), ("GITHUB_SHA", "main"),
                           ("SIGNING_MODE", "testflight"), ("SIGNING_CONFIRMATION", ""), ("BUILD_NUMBER", "1;command")]:
            with self.subTest(key=key), self.assertRaises(SigningError):
                invocation({**env, key: value})
        with self.assertRaises(SigningError):
            invocation({})

    def test_environment_name_alone_is_not_approval(self):
        for record in [{}, {"name": "ios-signing"}, {"name": "ios-signing", "protection_rules": [{"type": "required_reviewers", "reviewers": []}]}]:
            with self.assertRaises(SigningError):
                protected_environment(record)
        protected_environment({"name": "ios-signing", "protection_rules": [{"type": "required_reviewers", "reviewers": [{"type": "User"}]}]})

    def test_three_explicit_profiles_map_to_separate_targets(self):
        mapping = profiles(metadata(), TEAM, BUNDLE, IDENTITY, NOW)
        self.assertEqual(set(mapping), {BUNDLE, BUNDLE + ".voice-widget", BUNDLE + ".share"})
        options = export_options(TEAM, mapping, IDENTITY)
        self.assertEqual(options["destination"], "export")
        self.assertEqual(options["signingStyle"], "manual")

    def test_mismatched_expired_wildcard_or_nonstore_profiles_are_rejected(self):
        mutations = [lambda p: p.pop("widget"), lambda p: p["app"].update(ExpirationDate=NOW),
                     lambda p: p["app"].update(TeamIdentifier=["OTHER12345"]),
                     lambda p: p["share"].update(UUID=p["app"]["UUID"]),
                     lambda p: p["app"].update(ProvisionedDevices=["synthetic-device"]),
                     lambda p: p["app"].update(ProvisionsAllDevices=True),
                     lambda p: p["app"]["Entitlements"].update({"get-task-allow": True}),
                     lambda p: p["app"]["Entitlements"].update({"application-identifier": TEAM + ".*"}),
                     lambda p: p["share"]["Entitlements"].update({"com.apple.security.application-groups": []}),
                     lambda p: p["app"]["Entitlements"].update({"aps-environment": "development"}),
                     lambda p: p["app"].update(DeveloperCertificates=[b"another certificate"])]
        for mutate in mutations:
            data = copy.deepcopy(metadata()); mutate(data)
            with self.assertRaises(SigningError):
                profiles(data, TEAM, BUNDLE, IDENTITY, NOW)

    def test_workflow_never_runs_on_push_or_publishes_private_artifacts(self):
        workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ios-signing.yml").read_text()
        import re
        triggers = re.search(r"\non:\n(.*?)(?=\n[^ ])", workflow, re.S).group(1)
        self.assertEqual(re.findall(r"^  ([a-z_]+):", triggers, re.M), ["workflow_dispatch"])
        self.assertIn("vars.HUB_IOS_SIGNING_ENABLED == 'true'", workflow)
        self.assertIn("environment: ios-signing", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertNotRegex(workflow, r"uses:.*upload-artifact|contents: write|continue-on-error: true")

    def test_runner_cleanup_and_secret_isolation_with_synthetic_tools_only(self):
        # No actual security/codesign/Xcode/Apple call. Synthetic public metadata
        # cannot prove certificate trust, valid signing, export or upload.
        import base64
        records = metadata()
        for value in records.values():
            value["ExpirationDate"] = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) + dt.timedelta(days=7)
        data_env = {"IOS_TEAM_ID": TEAM, "IOS_DISTRIBUTION_P12_PASSWORD": "synthetic-password",
                    "IOS_DISTRIBUTION_P12_BASE64": base64.b64encode(b"not a private key").decode(), "BUILD_NUMBER": "123",
                    "IOS_ASC_KEY_ID": "FIXTURE123", "IOS_ASC_ISSUER_ID": "00000000-0000-0000-0000-000000000001",
                    "IOS_ASC_APP_ID": "123456", "IOS_ASC_PRIVATE_KEY_P8_BASE64": base64.b64encode(b"not an API key").decode(),
                    "GITHUB_TOKEN": "synthetic-token-not-for-subprocesses"}
        for target in records:
            data_env["IOS_PROFILE_" + target.upper() + "_BASE64"] = base64.b64encode(b"synthetic " + target.encode()).decode()
        original_temp = tempfile.TemporaryDirectory
        for failure in (False, True):
            with original_temp(prefix="hub-eval-signing-") as test_root:
                home = Path(test_root) / "home"; home.mkdir(); commands = []
                def fake_run(args, **kwargs):
                    args = [str(arg) for arg in args]; commands.append(args)
                    self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
                    self.assertNotIn("IOS_DISTRIBUTION_P12_PASSWORD", kwargs["env"])
                    output = b""; code = 0
                    if args[:2] == ["xcodebuild", "-help"]:
                        output = b"app-store-connect"
                    elif "find-identity" in args:
                        output = (f'1) {IDENTITY} "Apple Distribution: Synthetic ({TEAM})"').encode()
                    elif "find-certificate" in args:
                        output = b"-----BEGIN CERTIFICATE-----\nSYNTHETIC\n-----END CERTIFICATE-----"
                    elif "list-keychains" in args and "-s" not in args:
                        output = b'"synthetic-original-keychain"'
                    elif "cms" in args:
                        target = Path(args[-1]).stem; output = plistlib.dumps(records[target])
                    elif args[0] == "xcodebuild" and "archive" in args:
                        if failure: code = 1
                        else:
                            app = Path(args[args.index("-archivePath") + 1]) / "Products/Applications/App.app"
                            for folder, bundle in ((app, BUNDLE), (app / "PlugIns/HubVoiceWidget.appex", BUNDLE + ".voice-widget"), (app / "PlugIns/HubShareExtension.appex", BUNDLE + ".share")):
                                folder.mkdir(parents=True, exist_ok=True)
                                (folder / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": bundle, "CFBundleVersion": "123", "CFBundleShortVersionString": "0.1.0"}))
                    elif "-exportArchive" in args:
                        destination = Path(args[args.index("-exportPath") + 1]); destination.mkdir(); (destination / "Synthetic.ipa").write_bytes(b"not an IPA")
                    elif args[:3] == ["xcrun", "altool", "--help"]:
                        output = b"--upload-package --apiKey --apiIssuer"
                    elif args[:3] == ["xcrun", "altool", "--upload-package"]:
                        self.assertTrue(Path(kwargs["env"]["API_PRIVATE_KEYS_DIR"]).is_relative_to(Path(test_root)))
                    return subprocess.CompletedProcess(args, code, stdout=output)
                def private_temp(*args, **kwargs):
                    return original_temp(*args, **kwargs, dir=test_root)
                with patch.dict(os.environ, data_env), patch.object(signing_runner.sys, "platform", "darwin"), \
                     patch.object(signing_runner, "verify_environment"), patch.object(signing_runner.Path, "home", return_value=home), \
                     patch.object(signing_runner.tempfile, "TemporaryDirectory", side_effect=private_temp), \
                     patch.object(signing_runner.subprocess, "run", side_effect=fake_run), \
                     patch.object(signing_runner.ssl, "PEM_cert_to_DER_cert", return_value=CERT), \
                     patch.object(signing_runner.json, "loads", return_value={"appId": BUNDLE}), redirect_stdout(io.StringIO()):
                    if failure:
                        with self.assertRaises(SigningError): signing_runner.execute("archive")
                    else:
                        signing_runner.execute("testflight")
                self.assertTrue(any("delete-keychain" in command for command in commands))
                self.assertTrue(any(command[:5] == ["security", "list-keychains", "-d", "user", "-s"] and command[-1] == "synthetic-original-keychain" for command in commands))
                self.assertEqual(list(home.rglob("*.mobileprovision")), [])
                self.assertEqual(list(Path(test_root).glob("hub-ios-sign-*")), [])


if __name__ == "__main__":
    unittest.main()
