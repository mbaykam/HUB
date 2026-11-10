#!/bin/bash
set -eu
# Direct imports distinguish SDK support from an inactive canImport branch.
# No signing, accounts, device access or capture happens in this probe.
probe_dir=$(mktemp -d)
printf 'import ScreenCaptureKit\n' > "$probe_dir/Probe.swift"
for sdk in iphoneos iphonesimulator; do
  sdk_root=$(xcrun --sdk "$sdk" --show-sdk-path)
  target=arm64-apple-ios27.0
  if [ "$sdk" = iphonesimulator ]; then target=arm64-apple-ios27.0-simulator; fi
  if xcrun swiftc -typecheck -sdk "$sdk_root" -target "$target" "$probe_dir/Probe.swift" > "$probe_dir/$sdk.log" 2>&1; then
    echo "SCREEN_CAPTURE_KIT_${sdk}=available"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "${sdk}_available=true" >> "$GITHUB_OUTPUT"; fi
  else
    echo "SCREEN_CAPTURE_KIT_${sdk}=unavailable"
    if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "${sdk}_available=false" >> "$GITHUB_OUTPUT"; fi
    head -n 8 "$probe_dir/$sdk.log"
  fi
done
