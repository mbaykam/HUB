import UIKit
import Capacitor
import UserNotifications

final class HubWorkspaceNavigationController: UINavigationController {
    override var childForStatusBarStyle: UIViewController? { topViewController }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // Links, toggles and progress bars use the HUB accent instead of system blue.
        window?.tintColor = HubWorkspacePalette.accentUIColor
        window?.rootViewController = HubWorkspaceNavigationController(rootViewController: HubConnectionViewController())
        window?.makeKeyAndVisible()

        if let response = connectionOptions.notificationResponse,
           response.actionIdentifier == UNNotificationDefaultActionIdentifier || response.actionIdentifier == "hub.open" {
            HubNotifications.shared.receive(response.notification.request.content.userInfo)
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // Opened from a widget or Lock Screen shortcut while HUB was closed.
        for context in connectionOptions.urlContexts {
            if let action = HubQuickAction(url: context.url) { HubQuickActions.request(action) }
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        var others = Set<UIOpenURLContext>()
        for context in URLContexts {
            if let action = HubQuickAction(url: context.url) { HubQuickActions.request(action) } else { others.insert(context) }
        }
        if !others.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: others) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
