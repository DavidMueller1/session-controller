import Cocoa

// Lightweight menu bar controller for Session Controller.
// Lives in the macOS status bar (no Dock icon): shows our logo plus a badge with the
// number of Holding (non-parked) sessions — the ones flashing for your attention — and
// can start/stop the local server and open the dashboard.

let kPort = 4317
let kBase = "http://localhost:\(kPort)"

// The auto-updater targets ONLY the managed clone — never a dev checkout.
let kRepo = ("~/Library/Application Support/Session Controller/repo" as NSString).expandingTildeInPath
let kUpdateScript = kRepo + "/scripts/update.sh"
let kUpdateInterval: TimeInterval = 30 * 60   // 30 minutes

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var serverProcess: Process?          // set only if WE started the server
    var pollTimer: Timer?
    var starting = false
    // Last state rendered, so we only redraw on real changes (redrawing every tick
    // causes flicker under App Nap).
    var lastRendered: String?
    lazy var logo: NSImage = loadLogo()

    let headerItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let openItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
    let startItem = NSMenuItem(title: "Start Server", action: #selector(start), keyEquivalent: "s")
    let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stop), keyEquivalent: "x")

    var updateTimer: Timer?
    var checkingUpdate = false
    let versionItem = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
    let checkUpdateItem = NSMenuItem(title: "Check for Updates Now", action: #selector(checkForUpdatesClicked), keyEquivalent: "u")

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        let menu = NSMenu()
        menu.autoenablesItems = false
        headerItem.isEnabled = false
        for item in [openItem, startItem, stopItem, checkUpdateItem] { item.target = self }
        versionItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(startItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(versionItem)
        menu.addItem(checkUpdateItem)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu

        render(running: false, holding: 0)
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.refresh() }

        // Hands-off: launch the server on start-up so the app (as a Login Item) keeps the
        // dashboard always-on. Skips if something is already listening on the port —
        // e.g. a `pnpm serve` you started, or a previous launch that's still up.
        if !isPortOpen() { start() }

        // Keep the app up to date: check shortly after launch, then on an interval.
        refreshVersion()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.runUpdateCheck() }
        updateTimer = Timer.scheduledTimer(withTimeInterval: kUpdateInterval, repeats: true) { [weak self] _ in self?.runUpdateCheck() }
    }

    func applicationWillTerminate(_ note: Notification) {
        // only tear down the server if this app is the one that launched it.
        if serverProcess != nil, isPortOpen() { killPort() }
    }

    // MARK: - Actions

    @objc func start() {
        guard !isPortOpen(), serverProcess == nil else { return }
        guard let script = Bundle.main.path(forResource: "launch", ofType: "sh") else {
            alert("launch.sh missing from app bundle.")
            return
        }
        starting = true
        render(running: false, holding: 0)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [script]
        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.serverProcess = nil
                self?.starting = false
                self?.refresh()
            }
        }
        do {
            try proc.run()
            serverProcess = proc
        } catch {
            starting = false
            alert("Failed to start: \(error.localizedDescription)")
            render(running: false, holding: 0)
        }
    }

    @objc func stop() {
        killPort()
        serverProcess?.terminate()
        serverProcess = nil
        starting = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            if self?.isPortOpen() == true { self?.killPort(force: true) }
            self?.refresh()
        }
        render(running: false, holding: 0)
    }

    @objc func openDashboard() {
        if let url = URL(string: kBase) { NSWorkspace.shared.open(url) }
    }

    @objc func quit() { NSApp.terminate(nil) }

    // MARK: - Self-update

    @objc func checkForUpdatesClicked() { runUpdateCheck() }

    // Run the update engine off the main thread; act on its exit-code contract.
    func runUpdateCheck() {
        guard !checkingUpdate else { return }
        guard FileManager.default.fileExists(atPath: kUpdateScript) else { return }
        checkingUpdate = true
        versionItem.title = "Updating…"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let code = self?.runCode("/bin/bash", [kUpdateScript]) ?? -1
            DispatchQueue.main.async {
                self?.checkingUpdate = false
                switch code {
                case 10: self?.restartServer()
                case 20: self?.relaunchApp(); return   // process is terminating
                case 1:  self?.versionItem.title = "Update failed — staying put"
                default: break
                }
                self?.refreshVersion()
            }
        }
    }

    // Exit 10: new server/web code — bounce the server so it reloads.
    func restartServer() {
        killPort(force: true)
        serverProcess?.terminate(); serverProcess = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.start() }
    }

    // Exit 20: the .app itself was rebuilt. Wait for THIS process to exit (freeing the
    // port), then open the freshly installed bundle — so two instances never fight over :4317.
    func relaunchApp() {
        let pid = ProcessInfo.processInfo.processIdentifier
        let helper = "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; sleep 0.5; open \"/Applications/Session Controller.app\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", helper]
        try? p.run()
        killPort(force: true)
        NSApp.terminate(nil)
    }

    func refreshVersion() {
        let v = run("/usr/bin/git", ["-C", kRepo, "describe", "--tags", "--always"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        versionItem.title = v.isEmpty ? "Session Controller" : "Version \(v)"
    }

    // Like run(), but returns the process exit code instead of stdout.
    @discardableResult
    func runCode(_ launchPath: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }

    // MARK: - State

    // Poll the badge endpoint: a 200 means the server is up; the body carries the count.
    func refresh() {
        guard let url = URL(string: "\(kBase)/api/badge") else { return }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            var running = false
            var holding = 0
            if let http = resp as? HTTPURLResponse, http.statusCode == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                running = true
                holding = (obj["holding"] as? Int) ?? 0
            }
            DispatchQueue.main.async { self?.render(running: running, holding: holding) }
        }.resume()
    }

    // Apply state to the menu bar, but only when it actually changed.
    func render(running: Bool, holding: Int) {
        if running { starting = false }
        let key = "\(running)-\(starting)-\(holding)"
        if key == lastRendered { return }
        lastRendered = key

        if let button = statusItem.button {
            button.image = logo
            button.imagePosition = .imageLeft
            button.alphaValue = running ? 1.0 : 0.45
            if running && holding > 0 {
                button.attributedTitle = NSAttributedString(string: " \(holding)", attributes: [
                    .foregroundColor: NSColor.systemOrange,
                    .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                ])
            } else {
                button.title = ""
            }
        }

        if running {
            headerItem.title = holding > 0
                ? "● \(holding) holding — need you"
                : "● Nothing waiting on you"
        } else if starting {
            headerItem.title = "Starting…"
        } else {
            headerItem.title = "○ Server stopped"
        }
        startItem.isEnabled = !running && !starting
        stopItem.isEnabled = running || starting
        openItem.isEnabled = running
    }

    // MARK: - Icon

    // Our radar logo, rendered to a bundled PNG at build time. Kept colored (not a
    // template) so it reads as the brand mark rather than a flat glyph.
    func loadLogo(size pt: CGFloat = 18) -> NSImage {
        // NSImage (macOS 13+) renders the SVG as a crisp, transparent, colored vector.
        if let p = Bundle.main.path(forResource: "statusicon", ofType: "svg"),
           let img = NSImage(contentsOfFile: p) {
            img.size = NSSize(width: pt, height: pt)
            img.isTemplate = false
            return img
        }
        // fallback so the app is never invisible in the bar
        let sym = NSImage(systemSymbolName: "dot.radiowaves.left.and.right", accessibilityDescription: "Session Controller")
        sym?.isTemplate = true
        return sym ?? NSImage()
    }

    // MARK: - Helpers

    // IMPORTANT: filter to LISTEN sockets only. A bare `lsof -ti tcp:PORT` also lists
    // every *client* connected to the port — including this app (it polls /api/badge)
    // and the browser — so killing that set would take us (and the dashboard tab) down
    // with the server. `-sTCP:LISTEN` matches just the server, and we still guard our PID.
    func serverPIDs() -> [String] {
        let mine = String(ProcessInfo.processInfo.processIdentifier)
        return run("/usr/sbin/lsof", ["-ti", "tcp:\(kPort)", "-sTCP:LISTEN"])
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .filter { $0 != mine }
    }

    func isPortOpen() -> Bool { !serverPIDs().isEmpty }

    func killPort(force: Bool = false) {
        for pid in serverPIDs() { _ = run("/bin/kill", force ? ["-9", pid] : [pid]) }
    }

    @discardableResult
    func run(_ launchPath: String, _ args: [String]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        do { try p.run() } catch { return "" }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    func alert(_ msg: String) {
        let a = NSAlert()
        a.messageText = "Session Controller"
        a.informativeText = msg
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
app.run()
