/// A late navigation or foreground callback cannot recover a newer visible page.
public struct HubPageRecovery: Sendable {
    private var generation = 0
    private var pending = false
    public init() {}
    public mutating func begin() -> Int { generation += 1; pending = true; return generation }
    public mutating func cancel() { generation += 1; pending = false }
    public mutating func visible(_ expected: Int) -> Bool {
        guard pending, expected == generation else { return false }
        pending = false; return true
    }
    public mutating func expired(_ expected: Int) -> Bool {
        guard pending, expected == generation else { return false }
        pending = false; return true
    }
    public static func failedHTTP(status: Int, mainFrame: Bool) -> Bool { mainFrame && status >= 400 }
}
