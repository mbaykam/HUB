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
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
