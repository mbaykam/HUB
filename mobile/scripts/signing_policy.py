"""Fail-closed policy for a future, explicitly invoked signing run.

Pure metadata checks are testable without Apple accounts or signing secrets.
They do not replace CMS/certificate validation, Xcode signing or phone acceptance.
"""
import datetime as dt
import hashlib
import re


class SigningError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise SigningError(message)


def invocation(env):
    require(env.get("GITHUB_REPOSITORY") == "mbaykam/HUB" and
            env.get("GITHUB_REF") == "refs/heads/main" and
            env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and
            env.get("GITHUB_WORKFLOW_REF") == "mbaykam/HUB/.github/workflows/ios-signing.yml@refs/heads/main",
            "Signing requires the trusted main-branch manual workflow.")
    require(env.get("SIGNING_ENABLED") == "true", "Signing has not been enabled by the account owner.")
    require(re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")), "Invalid source identity.")
    mode = env.get("SIGNING_MODE")
    require(mode in ("archive", "testflight"), "Invalid signing mode.")
    expected = "ARCHIVE_ONLY" if mode == "archive" else "UPLOAD_TO_TESTFLIGHT"
    require(env.get("SIGNING_CONFIRMATION") == expected, "Confirm the selected signing action in the manual workflow.")
    require(re.fullmatch(r"[1-9][0-9]{0,3}", env.get("BUILD_NUMBER", "")), "Choose a numeric build number from 1 to 9999.")
    return mode


def protected_environment(record):
    require(record.get("name") == "ios-signing", "The signing environment was not found.")
    require(any(rule.get("type") == "required_reviewers" and rule.get("reviewers")
                for rule in record.get("protection_rules", [])),
            "Configure required reviewers on the signing environment first.")


def profiles(records, team, bundle, identity_sha1, now=None):
    require(re.fullmatch(r"[A-Z0-9]{10}", team or ""), "Invalid signing team.")
    require(re.fullmatch(r"[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}", bundle or ""), "Invalid app identifier.")
    require(re.fullmatch(r"[0-9A-F]{40}", identity_sha1 or ""), "Invalid signing identity.")
    require(set(records) == {"app", "widget", "share"}, "All three provisioning profiles are required.")
    now = now or dt.datetime.now(dt.timezone.utc)
    group = "group." + bundle
    result = {}
    for target, suffix in (("app", ""), ("widget", ".voice-widget"), ("share", ".share")):
        profile = records[target]
        require(isinstance(profile, dict), "Invalid provisioning metadata.")
        identifier = profile.get("UUID", "")
        require(isinstance(identifier, str) and re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", identifier), "Invalid profile identity.")
        require(identifier not in result.values(), "Profiles must have separate identities.")
        require(profile.get("TeamIdentifier") == [team] and profile.get("ApplicationIdentifierPrefix") == [team], "Profile team/prefix mismatch.")
        require("iOS" in profile.get("Platform", []), "An iOS distribution profile is required.")
        expiry = profile.get("ExpirationDate")
        require(isinstance(expiry, dt.datetime), "Missing profile expiration.")
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=dt.timezone.utc)
        require(expiry > now + dt.timedelta(hours=1), "A provisioning profile expires too soon.")
        entitlements = profile.get("Entitlements", {})
        require(entitlements.get("application-identifier") == team + "." + bundle + suffix and
                entitlements.get("com.apple.developer.team-identifier") == team, "Profile app identifier mismatch.")
        require(entitlements.get("get-task-allow") is False and not profile.get("ProvisionedDevices") and not profile.get("ProvisionsAllDevices"), "Use App Store distribution profiles, not development/ad-hoc/enterprise profiles.")
        groups = entitlements.get("com.apple.security.application-groups", [])
        require(isinstance(groups, list) and all(value == group for value in groups), "Unexpected App Group.")
        if target in ("app", "share"):
            require(groups == [group], "App and Share profiles must allow the committed App Group.")
        if target == "app":
            require(entitlements.get("aps-environment") == "production", "The app distribution profile must enable production notifications.")
        certificates = profile.get("DeveloperCertificates", [])
        require(isinstance(certificates, list) and any(isinstance(value, bytes) and 0 < len(value) <= 100_000 and
                hashlib.sha1(value).hexdigest().upper() == identity_sha1 for value in certificates), "The imported signing identity is not in every profile.")
        result[bundle + suffix] = identifier
    return result


def export_options(team, mapping, identity):
    return {"method": "app-store-connect", "destination": "export", "signingStyle": "manual",
            "teamID": team, "signingCertificate": identity, "provisioningProfiles": mapping,
            "manageAppVersionAndBuildNumber": False, "uploadSymbols": False}
