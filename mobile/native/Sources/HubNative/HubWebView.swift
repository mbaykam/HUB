#if canImport(UIKit) && canImport(WebKit)
import UIKit
import WebKit

/// Removes WebKit's form-navigation accessory while retaining its keyboard and
/// editor behavior. Uses the public UIResponder override only.
public class HubWebView: WKWebView {
    public override var inputAccessoryView: UIView? { nil }
}
#endif
