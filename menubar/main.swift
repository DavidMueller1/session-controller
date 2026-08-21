import Cocoa
import WebKit

// Lightweight menu bar controller for Session Controller.
// Lives in the macOS status bar (no Dock icon): shows our logo plus a badge with the
// number of Holding (non-parked) sessions — the ones flashing for your attention — and
// can start/stop the local server and open the dashboard.

let kPort = 4317
let kBase = "http://localhost:\(kPort)"
let kPanelURL = kBase + "/?panel"   // compact mini-board rendered inside the popover
let kBgColor = NSColor(srgbRed: 10 / 255, green: 14 / 255, blue: 20 / 255, alpha: 1)  // board --bg
let kPanelWidth: CGFloat = 380
let kPanelMinH: CGFloat = 110       // header + a little; the popover never shrinks below this
let kPanelMaxH: CGFloat = 560       // …and never grows past this (then the webview scrolls)

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

    // Left-click opens this popover (the web mini-board); right-click shows `menu`.
    let menu = NSMenu()
    var popover: NSPopover?
    var webView: WKWebView?

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

        // Route clicks ourselves so left and right can differ: left → popover mini-board,
        // right (or ctrl-click) → this menu. Setting statusItem.menu would hijack both.
        if let b = statusItem.button {
            b.target = self
            b.action = #selector(statusClicked)
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

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

    // MARK: - Click routing & popover

    @objc func statusClicked() {
        let ev = NSApp.currentEvent
        let rightish = ev?.type == .rightMouseUp || (ev?.modifierFlags.contains(.control) ?? false)
        // Left-click opens the mini-board — but only when the server is up to render it;
        // otherwise fall back to the menu (which offers Start Server).
        if rightish || !isPortOpen() { showMenu() } else { togglePopover() }
    }

    // Show the menu on demand without leaving it bound (which would steal left-clicks).
    func showMenu() {
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        DispatchQueue.main.async { self.statusItem.menu = nil }
    }

    func togglePopover() {
        if let p = popover, p.isShown { p.performClose(nil); return }
        guard let button = statusItem.button else { return }
        let p = popover ?? makePopover()
        popover = p
        p.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        // an accessory (LSUIElement) app must activate for the WKWebView to take keystrokes
        // (e.g. editing a strip's note); otherwise the popover renders but ignores typing.
        NSApp.activate(ignoringOtherApps: true)
    }

    func makePopover() -> NSPopover {
        // start compact; the page reports its real height over the "resize" bridge and we
        // grow/shrink the popover to fit (clamped to [kPanelMinH, kPanelMaxH]).
        let frame = NSRect(x: 0, y: 0, width: kPanelWidth, height: kPanelMinH)
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "resize")
        let wv = WKWebView(frame: frame, configuration: cfg)
        wv.uiDelegate = self
        if #available(macOS 12.0, *) { wv.underPageBackgroundColor = kBgColor }
        wv.load(URLRequest(url: URL(string: kPanelURL)!))
        webView = wv

        // Dark backing so any area not yet painted by the page matches the board rather
        // than flashing white on first open.
        let container = NSView(frame: frame)
        container.wantsLayer = true
        container.layer?.backgroundColor = kBgColor.cgColor
        wv.autoresizingMask = [.width, .height]
        container.addSubview(wv)

        let vc = NSViewController()
        vc.view = container

        let p = NSPopover()
        p.behavior = .transient
        p.contentSize = frame.size
        p.appearance = NSAppearance(named: .darkAqua)
        p.contentViewController = vc
        return p
    }

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
                    // Holding amber (#e0a92e) — matches the board's Holding lane, and no
                    // longer clashes now that the glyph beside it is a neutral template.
                    .foregroundColor: NSColor(srgbRed: 224 / 255, green: 169 / 255, blue: 46 / 255, alpha: 1),
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

    // Our radar logo. Rendered as a TEMPLATE image so macOS tints it for contrast on
    // ANY menu bar — near-black on light bars, white on dark or accent-tinted ones. A
    // fixed-color (green) glyph washed out on tinted bars; template mode fixes that. The
    // brand color returns when we revisit the logo itself.
    func loadLogo(size pt: CGFloat = 18) -> NSImage {
        // NSImage renders the SVG as a crisp transparent vector; isTemplate makes AppKit
        // use its shape (alpha) and pick the menu-bar-appropriate color automatically.
        if let p = Bundle.main.path(forResource: "statusicon", ofType: "svg"),
           let img = NSImage(contentsOfFile: p) {
            img.size = NSSize(width: pt, height: pt)
            img.isTemplate = true
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

extension AppDelegate: WKScriptMessageHandler {
    // The panel posts its natural content height; size the popover to it, clamped.
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "resize", let n = message.body as? NSNumber else { return }
        let h = max(kPanelMinH, min(kPanelMaxH, CGFloat(n.doubleValue)))
        if abs((popover?.contentSize.height ?? 0) - h) < 1 { return }
        popover?.contentSize = NSSize(width: kPanelWidth, height: h)
    }
}

extension AppDelegate: WKUIDelegate {
    // The panel's "Open full dashboard" is a target=_blank link; open it in the default
    // browser instead of trying to spawn a second WKWebView inside the popover.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
app.run()
