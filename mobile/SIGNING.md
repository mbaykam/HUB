# Manual iPhone signing handoff

The protected manual workflow has signed and exported the iPhone app with real
Apple credentials. Signing success does not prove TestFlight processing or
physical iPhone behavior. Offline policy/cleanup fixtures do not prove
certificate trust, signing, TestFlight processing or physical iPhone behavior.
The existing unsigned simulator/device workflow remains separate.

## Owner setup, after enrollment

1. Select the Apple team and register the final app, voice-widget and Share IDs
   and App Group. This deployment uses the registered `com.mbaykam.hub` IDs.
   Commit any identifier changes consistently; `pnpm check` verifies the project.
2. Create the corresponding App Store Connect app record in your own account. Prepare an
   existing Apple Distribution identity as a password-protected PKCS#12 file and
   three **App Store distribution** profiles. App and Share need the committed App
   Group; the app profile needs production notifications. Developer/ad-hoc and
   enterprise profiles are refused. The same certificate must be in all profiles.
3. In this repository, configure the **ios-signing** GitHub environment with
   required reviewers. For a solo owner, configure review so you can actually
   approve your own manually requested deployment. A similarly named environment
   without reviewer protection is refused by the runner's API preflight.
4. Put the existing material in that environment's encrypted secrets. Never put
   passwords, private keys, profiles or certificates in a chat, Git or an artifact.

| Environment secret | Existing material |
| --- | --- |
| `IOS_TEAM_ID` | Ten-character Apple team ID |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of the password-protected signing identity |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Its existing password |
| `IOS_PROFILE_APP_BASE64` | App profile, encoded as base64 |
| `IOS_PROFILE_WIDGET_BASE64` | Voice-widget profile, encoded as base64 |
| `IOS_PROFILE_SHARE_BASE64` | Share-extension profile, encoded as base64 |

For an actual TestFlight upload, also configure:

| Environment secret | Existing material |
| --- | --- |
| `IOS_ASC_KEY_ID` | App Store Connect API key ID |
| `IOS_ASC_ISSUER_ID` | API issuer UUID |
| `IOS_ASC_PRIVATE_KEY_P8_BASE64` | Base64 of that existing API private key |
| `IOS_ASC_APP_ID` | Numeric App Store Connect app Apple ID |
| `IOS_ASC_PROVIDER_PUBLIC_ID` | Optional provider public ID when needed for that account |

Use the narrowest account role suitable for your own app. The workflow does not
create keys, accounts, certificates, App IDs, profiles or App Store records. It
does not invite testers or submit the app for production review.

5. Only after protection/materials are configured, set the **repository** variable
   `HUB_IOS_SIGNING_ENABLED` to `true`. It is intentionally unset/disabled by this
   preparation. Environment-only variables are not a substitute for this job gate.

## Manually validate or upload

Run **iOS manual signing handoff** from `main`, at the reviewed source commit.
Choose a new build number from1–9999; all three targets use the same number. Use
a new invocation/build number after an upload rather than automatically retrying
an uncertain upload with the same version.

- `archive` + confirmation `ARCHIVE_ONLY`: validate profiles/identity, archive,
  verify and export privately. It deletes the exported package instead of
  publishing a downloadable signed artifact.
- `testflight` + confirmation `UPLOAD_TO_TESTFLIGHT`: the same checks, then one
  authenticated upload to the existing app. Apple processing and signing/device
  acceptance remain separate; command success does not mean it is installable yet.

The job is restricted to the exact repository/main/manual workflow, requires
the explicit enablement flag, and enters the protected environment. It checks
that reviewer protection really exists before decoding signing material.
Pushes, PRs and schedules cannot sign or upload. No automatic provisioning update
flag is used. Profile specifiers are separate for app/widget/Share, so the app's
profile cannot accidentally be applied to an extension.

All decoded credentials, command output, archives and packages stay in a private
temporary directory. Profiles are installed only at their validated UUID paths;
existing runner profiles are never overwritten. The temporary keychain's search
list is restored, owned profile files are removed, and temporary content is
deleted on success/failure. Nothing from signing is uploaded as a public GitHub
artifact. Private diagnostic output is withheld; real signing failures require
review in the owner's controlled signing environment, not dumping secrets into CI.

## Compatibility and acceptance

Deliver the matching HUB host/PWA through the normal supported update before the
first phone test, with a private backup and no active user work. Older installed
hosts may support voice but lack native screen, conversation or push routes.
Keep [ACCEPTANCE.md](ACCEPTANCE.md) open during signing/device acceptance. A
successful unsigned build, metadata fixture or signed export is not a finished
iPhone release. Keep account credentials and deployment evidence private.

Apple documents [uploading builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
and [API-authenticated altool uploads](https://help.apple.com/asc/appsaltool/en.lproj/static.html).
The runner checks its installed CLI help and uses `--upload-package`, not the
deprecated `--upload-app`. Keys stay in a temporary `API_PRIVATE_KEYS_DIR`.
[Xcode16 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-16-release-notes)
describe the current profile directory. [GitHub's environment documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
explains reviewer protection; naming an environment alone does not configure it.
