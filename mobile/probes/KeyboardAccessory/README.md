# Real keyboard accessory probe

The production `HubWebView` subclasses `WKWebView` and overrides only the public `UIResponder.inputAccessoryView` property to return `nil`. It does not change the keyboard, contenteditable, input traits, input assistant groups, or editor handlers. Apple's [public property documentation](https://developer.apple.com/documentation/uikit/uiresponder/inputaccessoryview) permits responder subclasses to supply the accessory view. Current WebKit's [content view implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm) asks its web view for that property; the [WKWebView implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm) supplies the normal form accessory. These sources support testing this public override; they do not establish behavior on every released iOS version.

## Run on a graphical Mac with Xcode and an iOS simulator

Generate a separate disposable app and UI-test project. The generated app compiles the **actual production** `mobile/native/Sources/HubNative/HubWebView.swift` directly, alongside the probe host. It does not edit the main app project, install dependencies, or use private APIs.

```sh
python3 mobile/probes/KeyboardAccessory/generate-project.py --output "$RUNNER_TEMP/hub-keyboard-probe"
xcrun simctl list devices available
xcodebuild test \
  -project "$RUNNER_TEMP/hub-keyboard-probe/KeyboardAccessory.xcodeproj" \
  -scheme KeyboardAccessory \
  -destination 'platform=iOS Simulator,id=YOUR_DISPOSABLE_SIMULATOR_UDID' \
  -resultBundlePath "$RUNNER_TEMP/hub-keyboard-probe.xcresult" \
  CODE_SIGNING_ALLOWED=NO
```

On a local Mac without `RUNNER_TEMP`, provide an explicit temporary output/evidence directory. Use a disposable simulator with its software keyboard enabled. If a connected hardware keyboard prevents presentation, disable that option in Simulator before running; the probe does not silently change host preferences or simulate success with JavaScript focus. CI can archive the `.xcresult`, including its kept screenshots/accessibility attachments. Inspect attachments in Xcode's test report; recent Xcodes also support `xcrun xcresulttool export attachments --path <result.xcresult> --output-path <directory>`.

## What is actually checked

Each test launches a normal `WKWebView` baseline and then `HubWebView`, using identical synthetic local HTML in nonpersistent storage with network-blocking CSP. It physically taps a real accessible `contenteditable`, requires the actual software keyboard, types English or Turkish Unicode text through public XCTest UI APIs, and verifies the text received by that same editor. A small probe-only message handler reports the synthetic input text to a native accessible status label; it does not service application operations.

The baseline must expose accessible Previous, Next **and** Done form-navigation controls. The override must expose none of them while preserving the keyboard and exact typed text. Screenshots use `XCUIScreen`, so they include the actual system keyboard/accessory rather than a web-view-only snapshot. Baseline/override screenshots and public accessibility trees are kept in the test result, including failures. Unknown localized accessibility labels, an absent baseline form bar, a missing keyboard, a Unicode typing failure, or an inaccessible contenteditable fail the run and require inspection; none constitutes proof that the accessory was removed.

App locale/language arguments exercise English/Turkish synthetic text; they do not install or select a particular system keyboard layout. Predictive text, dictation, selection/editing behavior and installed keyboard choices still need physical-device acceptance. The fixture has no accounts, model calls or user data. No screenshot/typing success is claimed until the iOS simulator test actually executes.

On the Windows development host, only project generation and generated XML/reference consistency were checked. Swift/Xcode compilation, real keyboard presentation, bar removal, Unicode input and physical iPhone behavior remain unverified there.
