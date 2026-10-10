import Cocoa
import Sparkle
import SwiftUI

final class ServiceState {
 var phase = "Starting"
 var sends = "Unknown"
 var allowlist = "Unknown"
 var error = "None"
 var ready = false
}
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
 let state = ServiceState()
 var status: NSStatusItem!
 var menu: NSMenu!
 var header: NSView!
 var phaseLabel: NSTextField!
 var errorLabel: NSTextField!
 var setupItem: NSMenuItem!
 var displayTimer: Timer?
 var service: Process?
 var settingsWindow: NSWindow?
 var settingsModel: SettingsModel?
 var paused = false
 var updater: SPUStandardUpdaterController!
 var outputPipe: Pipe?
 var refreshTimer: Timer?
 var checking = false
 var generation = 0
 var quitting = false
 var terminationSignal: DispatchSourceSignal?
 let logQueue = DispatchQueue(label: "in.msgzle.logs")
 let dataDir = ProcessInfo.processInfo.environment["MSGZLE_TEST_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Msgzle", isDirectory: true)
 let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Msgzle", isDirectory: true)
 var logURL: URL!
 var logHandle: FileHandle?
 var instance = UUID().uuidString
 var token = ""
 let session = URLSession(configuration: .ephemeral)
 func applicationDidFinishLaunching(_ notification: Notification) {
  status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  if let image = NSImage(named: "MenuBarTemplate") {
   image.isTemplate = true; image.size = NSSize(width: 18, height: 18); status.button?.image = image
  } else { status.button?.title = "Msgzle" }
  status.button?.toolTip = "Msgzle service status"
  signal(SIGTERM, SIG_IGN)
  terminationSignal = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  terminationSignal?.setEventHandler { NSApp.terminate(nil) }
  terminationSignal?.resume()
  configureMenu()
  displayTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateMenu() }
  updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
  prepareLog()
  startService()
 }
 func prepareLog() {
  do {
   try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
   try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: logDir.path)
   logURL = logDir.appendingPathComponent("service-\(UUID().uuidString).log")
   guard FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
   logHandle = try FileHandle(forWritingTo: logURL)
   log("App launched")
  } catch { state.error = "Could not create local log. Check folder permissions." }
 }
 func log(_ message: String) {
  let secret = token
  logQueue.async { [weak self] in
   guard let self = self else { return }
   var safe = message
   if !secret.isEmpty { safe = safe.replacingOccurrences(of: secret, with: "[redacted]") }
   safe = safe.replacingOccurrences(of: "(?i)Bearer\\s+[^\\s]+|[A-Za-z0-9_-]{48,}", with: "[redacted]", options: .regularExpression)
   let text = "\(ISO8601DateFormatter().string(from: Date())) \(String(safe.prefix(2048)))\n"
   guard let bytes = text.data(using: .utf8) else { return }
   do {
    if let offset = try self.logHandle?.offset(), offset > 1_048_576 {
     try self.logHandle?.close()
     self.logURL = self.logDir.appendingPathComponent("service-\(UUID().uuidString).log")
     guard FileManager.default.createFile(atPath: self.logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
     self.logHandle = try FileHandle(forWritingTo: self.logURL)
    }
    try self.logHandle?.write(contentsOf: bytes)
   } catch { /* Never send private log contents to remote services. */ }
  }
 }
 func startService() {
  guard service?.isRunning != true, !quitting else { refresh(); return }
  paused = false
  generation += 1; let current = generation
  state.phase = "Starting"; state.ready = false; state.sends = "Unknown"; state.allowlist = "Unknown"
  state.error = "None"; token = ""; instance = UUID().uuidString
  guard let resource = Bundle.main.resourceURL else { failed("App resources are missing."); return }
  let process = Process(); process.executableURL = resource.appendingPathComponent("msgzle-server")
  process.environment = ProcessInfo.processInfo.environment.merging(["MSGZLE_INSTANCE": instance, "MSGZLE_ROLE": "mac", "MSGZLE_PORT": "19791", "MSGZLE_HOST": "127.0.0.1", "MSGZLE_DATA_DIR": dataDir.path]) { _, new in new }
  let pipe = Pipe(); outputPipe = pipe; process.standardOutput = pipe; process.standardError = pipe
  pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
   let data = handle.availableData
   if data.isEmpty { handle.readabilityHandler = nil; return }
   if let text = String(data: data, encoding: .utf8) {
    for line in text.split(separator: "\n") {
     if line.hasPrefix("Startup failed:") {
      let allowed = ["Startup failed: port is already in use.", "Startup failed: file or port access denied.", "Startup failed: service initialization failed."]
      if allowed.contains(String(line)) {
       self?.log(String(line))
       DispatchQueue.main.async { self?.state.error = String(line) }
      }
     }
     else if ["Diagnostic: dispatch started", "Diagnostic: dispatch uncertain"].contains(String(line)) { self?.log(String(line)) }
     else if line.hasPrefix("Msgzle mac:") { self?.log("Service listening on local port 19791") }
     else { self?.log("Service diagnostic output captured; contents omitted for privacy.") }
    }
   }
  }
  process.terminationHandler = { [weak self] child in
   DispatchQueue.main.async {
    guard let self = self, self.generation == current, !self.quitting, !self.paused else { return }
    let detail = self.state.error.hasPrefix("Startup failed:") ? self.state.error : "Service exited (code \(child.terminationStatus)). Open logs for details."
    self.failed(detail)
   }
  }
  do { service = process; try process.run(); log("Service launched"); startReadiness(current) }
  catch { service = nil; failed("Could not launch the service. Open logs for details."); log("Process launch failed, Cocoa code \((error as NSError).code)") }
 }
 func startReadiness(_ current: Int) {
  refreshTimer?.invalidate()
  var attempts = 0
  refreshTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
   guard let self = self, self.generation == current, self.service?.isRunning == true else { timer.invalidate(); return }
   attempts += 1; self.refresh()
   if self.state.ready { timer.invalidate() }
   else if attempts >= 50 { timer.invalidate(); self.failed("Service is not ready. Open logs or refresh status.") }
  }
 }
 func failed(_ message: String) {
  state.phase = "Stopped"; state.ready = false; state.sends = "Unknown"; state.allowlist = "Unknown"; state.error = message
  refreshTimer?.invalidate(); log(message)
 }
 func configureMenu() {
  menu = NSMenu(); menu.delegate = self; menu.autoenablesItems = false
  header = NSView(frame: NSRect(x: 0, y: 0, width: 280, height: 152))
  func label(_ text: String, _ rect: NSRect, _ font: NSFont, _ color: NSColor) -> NSTextField {
   let field = NSTextField(labelWithString: text); field.frame = rect; field.font = font; field.textColor = color
   header.addSubview(field); return field
  }
  _ = label("Msgzle", NSRect(x: 16, y: 120, width: 180, height: 21), .systemFont(ofSize: 13, weight: .semibold), .labelColor)
  let refreshButton = NSButton(frame: NSRect(x: 244, y: 119, width: 22, height: 22))
  refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh status")
  refreshButton.isBordered = false; refreshButton.target = self; refreshButton.action = #selector(refreshAction)
  refreshButton.toolTip = "Refresh status"; header.addSubview(refreshButton)
  phaseLabel = label("Starting", NSRect(x: 16, y: 89, width: 248, height: 21), .systemFont(ofSize: 13, weight: .semibold), .labelColor)
  _ = label("Port 19791", NSRect(x: 16, y: 67, width: 248, height: 18), .monospacedDigitSystemFont(ofSize: 11, weight: .regular), .secondaryLabelColor)
  _ = label("Last error", NSRect(x: 16, y: 42, width: 248, height: 17), .systemFont(ofSize: 11, weight: .medium), .secondaryLabelColor)
  errorLabel = label("None", NSRect(x: 16, y: 2, width: 248, height: 38), .systemFont(ofSize: 11), .secondaryLabelColor)
  errorLabel.maximumNumberOfLines = 2; errorLabel.lineBreakMode = .byWordWrapping
  let item = NSMenuItem(); item.view = header; menu.addItem(item); menu.addItem(.separator())
  setupItem = NSMenuItem(title: "Settings…", action: #selector(openSetupAction), keyEquivalent: ""); setupItem.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil); setupItem.target = self; menu.addItem(setupItem)
  let logs = NSMenuItem(title: "Open Logs", action: #selector(openLogsAction), keyEquivalent: ""); logs.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: nil); logs.target = self; menu.addItem(logs)
  menu.addItem(.separator())
  let quitItem = NSMenuItem(title: "Quit Msgzle", action: #selector(quitAction), keyEquivalent: "q"); quitItem.image = NSImage(systemSymbolName: "power", accessibilityDescription: nil); quitItem.target = self; menu.addItem(quitItem)
  status.menu = menu
  updateMenu()
 }
 func updateMenu() {
  phaseLabel.stringValue = "● " + state.phase
  phaseLabel.textColor = state.ready ? .systemGreen : state.phase == "Starting" ? .secondaryLabelColor : .systemRed
  errorLabel.stringValue = state.error; errorLabel.textColor = state.error == "None" ? .secondaryLabelColor : .systemRed
  errorLabel.toolTip = state.error; setupItem.isEnabled = true
 }
 func menuWillOpen(_ menu: NSMenu) { refresh(); updateMenu() }
 @objc func refreshAction() { refresh() }
 @objc func openSetupAction() { openSetup() }
 @objc func openLogsAction() { openLogs() }
 @objc func quitAction() { quit() }
 func refresh() {
  guard !checking else { return }
  guard service?.isRunning == true else { state.phase = "Stopped"; state.ready = false; return }
  do {
   let data = try Data(contentsOf: dataDir.appendingPathComponent("config.json"))
   guard let config = try JSONSerialization.jsonObject(with: data) as? [String: Any], let secret = config["token"] as? String, secret.count >= 32 else { return }
   token = secret
  } catch { return } // Config can be created shortly after process launch.
  checking = true; let current = generation
  var request = URLRequest(url: URL(string: "http://127.0.0.1:19791/v1/health")!); request.timeoutInterval = 1
  request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
  session.dataTask(with: request) { [weak self] data, response, _ in
   var result: [String: Any]?
   if (response as? HTTPURLResponse)?.statusCode == 200, let data = data { result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
   DispatchQueue.main.async {
    guard let self = self else { return }; self.checking = false
    guard self.generation == current, self.service?.isRunning == true else { return }
    guard let result = result, result["instance"] as? String == self.instance, result["role"] as? String == "mac", result["version"] as? String == "0.0.2", let enabled = result["sendEnabled"] as? Bool, let count = result["allowlistCount"] as? Int else {
     self.state.ready = false; self.state.sends = "Unknown"; self.state.allowlist = "Unknown"
     if self.state.phase != "Starting" { self.state.phase = "Unavailable"; self.state.error = "Status could not be verified. Open logs for details." }; return
    }
    self.state.phase = "Running"; self.state.ready = true; self.state.sends = enabled ? "On" : "Off"; self.state.allowlist = String(count); self.state.error = "None"
   }
  }.resume()
 }
 func toggleService() { if service?.isRunning == true { paused = true; refreshTimer?.invalidate(); service?.terminate(); state.phase = "Stopped"; state.ready = false; state.error = "None"; log("Service stopped by user") } else { startService() } }
 func openSetup() {
  log("Settings opened")
  if settingsWindow == nil {
   let model = SettingsModel(self); settingsModel = model
   let window = NSWindow(contentRect:NSRect(x:0,y:0,width:508,height:668),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
   window.title = "Msgzle"; window.isReleasedWhenClosed = false
   window.contentViewController = NSHostingController(rootView:SettingsView(model:model))
   window.center(); settingsWindow = window
  }
  settingsWindow?.center(); settingsWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true)
  // Hosting onAppear may run before window presentation. Never prompt from it.
  DispatchQueue.main.asyncAfter(deadline:.now()+0.35) { [weak self] in
   guard let self = self, self.settingsWindow?.isVisible == true, let model = self.settingsModel, model.contactsStatus == "Contacts not loaded" else { return }
   model.loadContacts()
  }
 }
 func checkUpdates() { updater.checkForUpdates(nil) }
 func openLogs() { logQueue.async { [weak self] in guard let self = self, let url = self.logURL else { return }; DispatchQueue.main.async { NSWorkspace.shared.open(url) } } }
 func revealConfig() { NSWorkspace.shared.activateFileViewerSelecting([dataDir.appendingPathComponent("config.json")]) }
 func quit() { NSApp.terminate(nil) }
 func applicationWillTerminate(_ notification: Notification) { quitting = true; displayTimer?.invalidate(); refreshTimer?.invalidate(); service?.terminate(); session.invalidateAndCancel() }
}
@main
struct MsgzleMain {
 static func main() {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  withExtendedLifetime(delegate) { app.run() }
 }
}
