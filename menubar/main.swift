import Cocoa
import WebKit

// Lightweight menu bar controller for Session Controller.
// Lives in the macOS status bar (no Dock icon): shows our logo plus a badge with the
// number of Holding (non-parked) sessions — the ones flashing for your attention — and
// can start/stop the local server and open the dashboard.

let kPort = 4317
let kBase = "http://localhost:\(kPort)"
let kPanelURL = kBase + "/?panel"   // compact mini-board rendered inside the popover
let kOverlayURL = kBase + "/?overlay"  // right-edge floating rail
let kBgColor = NSColor(srgbRed: 10 / 255, green: 14 / 255, blue: 20 / 255, alpha: 1)  // board --bg
let kPanelWidth: CGFloat = 380
let kPanelMinH: CGFloat = 110       // header + a little; the popover never shrinks below this
let kPanelMaxH: CGFloat = 560       // …and never grows past this (then the webview scrolls)
// Overlay: the panel is always this wide (so the strips have room to fly in), but stays
// click-through except within a band at the right edge — a thin sliver when collapsed, the
// full width once expanded — so it never blocks clicks to the apps underneath.
let kOverlayW: CGFloat = 300         // panel width — room for the card to fly in and be read
let kOverlayBand: CGFloat = 56       // the "live" band at the right edge: a strip stays revealed
                                     // only while the cursor is within this of the edge, in any
                                     // direction — so leaving left/up/down all collapse the same

// The auto-updater targets ONLY the managed clone — never a dev checkout.
let kRepo = ("~/Library/Application Support/Session Controller/repo" as NSString).expandingTildeInPath
let kUpdateScript = kRepo + "/scripts/update.sh"

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

    // Right-edge floating overlay (its own always-on-top, non-activating panel).
    var overlayPanel: NSPanel?
    var overlayWeb: WKWebView?
    var overlayTimer: Timer?
    // each strip's vertical rect (viewport px from the top), reported by the web, so we can
    // tell which one the cursor is over and reveal exactly that one.
    var overlayStrips: [(id: String, top: CGFloat, bottom: CGFloat)] = []
    var overlayActiveId: String?
    var overlayNilTicks = 0   // consecutive polls with the cursor off any strip (collapse grace)
    let overlayItem = NSMenuItem(title: "Show Overlay", action: #selector(toggleOverlay), keyEquivalent: "l")

    let headerItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let openItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "o")
    let startItem = NSMenuItem(title: "Start Server", action: #selector(start), keyEquivalent: "s")
    let stopItem = NSMenuItem(title: "Stop Server", action: #selector(stop), keyEquivalent: "x")
    // Minimal fallback menu, shown only when the server is unreachable (see statusClicked).
    let restartItem = NSMenuItem(title: "Restart Server", action: #selector(restartServerClicked), keyEquivalent: "r")

    // Server supervisor: keep the website up whenever the app runs.
    var serverReachable = false        // last /api/badge poll succeeded
    var intentionalStop = false        // don't auto-restart a server we stopped on purpose
    var restartTimes: [Date] = []      // recent auto-restarts, for crash-loop backoff
    var supervisorPaused = false       // set after a crash loop; stops the hammering
    var unreachableTicks = 0           // consecutive failed polls before we intervene

    var checkingUpdate = false
    let versionItem = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
    let checkUpdateItem = NSMenuItem(title: "Check for Updates Now", action: #selector(checkForUpdatesClicked), keyEquivalent: "u")

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        menu.autoenablesItems = false
        headerItem.isEnabled = false
        // The menu is now MINIMAL — Restart + Quit only (all normal controls live in the web
        // app's Settings). It's always available on right-click (so the app can always be
        // quit), and it's also what a left-click falls back to when the server is unreachable.
        // The other NSMenuItems are kept as properties (their actions still fire from the
        // web/popover) but are no longer shown here.
        restartItem.target = self
        let quit = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(restartItem)
        menu.addItem(quit)

        // Route clicks ourselves: when the server is reachable, a click opens the popover
        // mini-board; when it's NOT, it shows the fallback menu so you can restart/quit.
        if let b = statusItem.button {
            b.target = self
            b.action = #selector(statusClicked)
            b.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        render(running: false, holding: 0)
        refresh()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.refresh() }

        // Hands-off: launch the server on start-up so the app (as a Login Item) keeps the
        // dashboard always-on. Skips if something is already listening on the port —
        // e.g. a `pnpm serve` you started, or a previous launch that's still up.
        if !isPortOpen() { start() }

        // Update ON STARTUP only — apply once, shortly after launch. We deliberately do NOT
        // poll-and-apply on an interval anymore; while running, the server detects a newer
        // build and shows an "update available" banner, and the user restarts (or uses
        // "Check for Updates Now") to apply it.
        refreshVersion()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.runUpdateCheck() }

        // restore the overlay if it was on last time (once the server is up to serve it)
        if UserDefaults.standard.bool(forKey: "overlayEnabled") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.showOverlay() }
        }
    }

    func applicationWillTerminate(_ note: Notification) {
        intentionalStop = true
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
        intentionalStop = false   // we want it up; let the supervisor keep it up
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
        intentionalStop = true    // don't let the supervisor fight a deliberate stop
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

    @objc func quit() { intentionalStop = true; NSApp.terminate(nil) }

    // MARK: - Click routing & popover

    @objc func statusClicked() {
        let ev = NSApp.currentEvent
        let rightish = ev?.type == .rightMouseUp || (ev?.modifierFlags.contains(.control) ?? false)
        // Right-click (or ctrl-click) always shows the minimal menu, so Quit is always one
        // click away. Left-click opens the popover when reachable, else falls back to the menu.
        if rightish || !serverReachable { showMenu() } else { togglePopover() }
    }

    // Show the menu on demand without leaving it bound (which would steal left-clicks).
    func showMenu() {
        headerItem.title = serverReachable ? "Session Controller" : "Server unreachable"
        restartItem.title = serverReachable ? "Restart Server" : "Start Server"
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
        cfg.userContentController.add(self, name: "command")
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

    // MARK: - Overlay (right-edge floating rail)

    @objc func toggleOverlay() {
        if overlayPanel != nil { hideOverlay() } else { showOverlay() }
    }

    func showOverlay() {
        guard overlayPanel == nil else { return }
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let frame = NSRect(x: vf.maxX - kOverlayW, y: vf.minY, width: kOverlayW, height: vf.height)

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "overlay") // web reports where the strips are
        let wv = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: cfg)
        wv.setValue(false, forKey: "drawsBackground") // transparent webview (KVC — no public API)
        if #available(macOS 12.0, *) { wv.underPageBackgroundColor = .clear }
        wv.autoresizingMask = [.width, .height]
        wv.load(URLRequest(url: URL(string: kOverlayURL)!))
        overlayWeb = wv

        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true      // click-through until the cursor enters the edge band
        panel.contentView = wv
        panel.orderFrontRegardless()
        overlayPanel = panel

        overlayStrips = []; overlayActiveId = nil; overlayNilTicks = 0
        // poll the cursor: reveal the strip it's over + intercept clicks only there
        overlayTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.overlayTick() }

        UserDefaults.standard.set(true, forKey: "overlayEnabled")
        overlayItem.state = .on
        postAppState()   // let the web Settings toggle reflect it
    }

    func hideOverlay() {
        overlayTimer?.invalidate(); overlayTimer = nil
        overlayPanel?.orderOut(nil)
        overlayPanel = nil
        overlayWeb = nil
        UserDefaults.standard.set(false, forKey: "overlayEnabled")
        overlayItem.state = .off
        postAppState()
    }

    // Cursor-driven reveal (a non-activating panel gets no mouseMoved, so CSS :hover can't
    // work in the web view). We poll NSEvent.mouseLocation — which always works — find the
    // strip whose vertical rect the cursor is in, and tell the web to reveal it. The panel
    // intercepts clicks only while a strip is active (so it can be clicked); otherwise it's
    // click-through. Hysteresis: once a strip is active the whole width is live so the cursor
    // can move left onto the revealed card; otherwise only a narrow right-edge band (a spine).
    func overlayTick() {
        guard let panel = overlayPanel, let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let m = NSEvent.mouseLocation
        let fromRight = vf.maxX - m.x
        // strip whose vertical range contains the cursor (screen y = vf.maxY - web viewport y)
        let rowId = overlayStrips.first { s in
            m.y <= (vf.maxY - s.top) && m.y >= (vf.maxY - s.bottom)
        }?.id
        // one narrow edge band for both reveal AND stay-open, so leaving in any direction collapses
        let active = (rowId != nil && fromRight >= 0 && fromRight <= kOverlayBand) ? rowId : nil

        // clicks land only while the cursor is genuinely over a strip's edge band (immediate)
        panel.ignoresMouseEvents = (active == nil)
        if let active = active {
            overlayNilTicks = 0
            if active != overlayActiveId { setOverlayActive(active) } // reveal / switch is instant
        } else if overlayActiveId != nil {
            // a board re-render can blip the reported rects for a poll or two, so only collapse
            // the reveal after a couple consecutive empty polls (~100ms) to avoid flicker.
            overlayNilTicks += 1
            if overlayNilTicks >= 2 { overlayNilTicks = 0; setOverlayActive(nil) }
        }
    }

    func setOverlayActive(_ id: String?) {
        overlayActiveId = id
        let arg = id.map { "\"\($0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\"" } ?? "null"
        overlayWeb?.evaluateJavaScript("window.__overlayHover && window.__overlayHover(\(arg))", completionHandler: nil)
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

    // Exit 10: new server/web code — bounce the server so it reloads. Also the supervisor's
    // recovery path. Sets intentionalStop=false so the fresh server is kept up.
    func restartServer() {
        intentionalStop = false
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
        // Lead with the commit count ("Version 104") — a monotonic build number that ticks
        // up on every update, so "did it update?" is answerable at a glance even for two
        // updates the same day. Time + short hash disambiguate further.
        let g: ([String]) -> String = { args in
            self.run("/usr/bin/git", ["-C", kRepo] + args).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let build = g(["rev-list", "--count", "HEAD"])
        let sha = g(["rev-parse", "--short", "HEAD"])
        let dt = g(["log", "-1", "--format=%cd", "--date=format:%b %d, %H:%M"])
        if build.isEmpty && sha.isEmpty {
            versionItem.title = "Session Controller"
        } else {
            let head = build.isEmpty ? sha : build
            var tail: [String] = []
            if !dt.isEmpty { tail.append(dt) }
            if !sha.isEmpty && !build.isEmpty { tail.append(sha) }
            versionItem.title = "Version " + head + (tail.isEmpty ? "" : " · " + tail.joined(separator: " · "))
        }
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
            var wantsUpdate = false
            var commands: [String] = []
            if let http = resp as? HTTPURLResponse, http.statusCode == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                running = true
                holding = (obj["holding"] as? Int) ?? 0
                wantsUpdate = (obj["updateRequested"] as? Bool) ?? false
                commands = (obj["commands"] as? [String]) ?? []
            }
            DispatchQueue.main.async {
                guard let self = self else { return }
                let wasReachable = self.serverReachable
                self.serverReachable = running
                self.render(running: running, holding: holding)
                if running {
                    self.unreachableTicks = 0
                    self.restartTimes.removeAll { Date().timeIntervalSince($0) > 60 }
                    if !wasReachable { self.postAppState() }        // fresh server → sync overlay state
                    if wantsUpdate { self.runUpdateCheck() }
                    for c in commands { self.executeCommand(c) }    // web-app requests (overlay/quit/…)
                } else {
                    self.superviseIfNeeded()                        // keep the website up
                }
            }
        }.resume()
    }

    // Bring a crashed/wedged server back — the guarantee behind "website up while the app runs".
    func superviseIfNeeded() {
        if intentionalStop || supervisorPaused || starting { return }
        unreachableTicks += 1
        if unreachableTicks < 2 { return }   // ~2s of silence before intervening
        unreachableTicks = 0
        restartTimes.append(Date())
        restartTimes.removeAll { Date().timeIntervalSince($0) > 60 }
        if restartTimes.count > 3 {          // crash loop → stop hammering, leave the fallback menu
            supervisorPaused = true
            return
        }
        restartServer()                      // force-kill any wedged process + start fresh
    }

    func executeCommand(_ c: String) {
        switch c {
        case "overlay-toggle": toggleOverlay()
        case "overlay-show": if overlayPanel == nil { showOverlay() }
        case "overlay-hide": if overlayPanel != nil { hideOverlay() }
        case "restart": restartServerClicked()
        case "quit": quit()
        case "check-update": runUpdateCheck()
        default: break
        }
    }

    // Tell the server our native state (overlay on/off) so the web Settings toggle matches.
    func postAppState() {
        guard let url = URL(string: "\(kBase)/api/app/state") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 1.5
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["overlayShown": overlayPanel != nil])
        URLSession.shared.dataTask(with: req).resume()
    }

    @objc func restartServerClicked() {
        supervisorPaused = false
        restartTimes = []
        restartServer()
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
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "resize":
            // The panel posts its natural content height; size the popover to it, clamped.
            guard let n = message.body as? NSNumber else { return }
            let h = max(kPanelMinH, min(kPanelMaxH, CGFloat(n.doubleValue)))
            if abs((popover?.contentSize.height ?? 0) - h) < 1 { return }
            popover?.contentSize = NSSize(width: kPanelWidth, height: h)
        case "command":
            // Footer buttons in the panel drive the same native actions as the menu.
            guard let c = message.body as? String else { return }
            handleCommand(c)
        case "overlay":
            // The overlay web view reports each strip's vertical rect (viewport px from top).
            guard let d = message.body as? [String: Any], let arr = d["strips"] as? [[String: Any]] else { overlayStrips = []; return }
            overlayStrips = arr.compactMap { s in
                guard let id = s["id"] as? String,
                      let t = (s["top"] as? NSNumber)?.doubleValue,
                      let b = (s["bottom"] as? NSNumber)?.doubleValue else { return nil }
                return (id, CGFloat(t), CGFloat(b))
            }
        default:
            break
        }
    }

    func handleCommand(_ c: String) {
        switch c {
        case "update":  popover?.performClose(nil); runUpdateCheck()
        case "restart": popover?.performClose(nil); restartServer()
        case "stop":    popover?.performClose(nil); stop()
        case "quit":    quit()
        case "dashboard": openDashboard()
        case "menu":    showMenu()
        default: break
        }
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
