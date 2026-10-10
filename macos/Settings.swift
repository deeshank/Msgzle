import Cocoa
import SwiftUI
import Contacts
import ServiceManagement
import UserNotifications

final class SettingsModel: ObservableObject {
 @Published var enabled = false
 @Published var everyone = false
 @Published var recipients: [String] = []
 @Published var input = ""
 @Published var contactsStatus = "Contacts not loaded"
 @Published var suggestions: [(String,String)] = []
 @Published var message = ""
 @Published var phase = "Checking"
 @Published var lastSend = "None"
 @Published var retryCap = 0
 @Published var rate = 6
 @Published var debug = false
 @Published var reveal = false
 @Published var accessToken = ""
 @Published var relayURL = ""
 @Published var relayToken = ""
 @Published var notify = UserDefaults.standard.bool(forKey: "notifyFailures")
 @Published var login = false
 @Published var automaticUpdates = true
 @Published var showTest = false
 @Published var testRecipient = ""
 @Published var testText = "Msgzle test"
 @Published var confirmTest = false
 var loading = false
 var timer: Timer?
 var contacts: [(String,String)] = []
 unowned let owner: AppDelegate
 var lastNotified = ""
 init(_ owner: AppDelegate) { self.owner = owner; login = SMAppService.mainApp.status == .enabled; automaticUpdates = owner.updater.updater.automaticallyDownloadsUpdates; timer = Timer.scheduledTimer(withTimeInterval:10,repeats:true) { [weak self] _ in self?.refresh() } }
 var version: String { let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"; let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"; return Bundle.main.object(forInfoDictionaryKey: "MsgzleReleaseBuild") as? Bool == true ? "v\(v) (\(b))" : "Build \(b)" }
 func request(_ path: String, body: [String:Any]? = nil, completion: @escaping ([String:Any]?) -> Void) {
  guard owner.state.ready else { message = "Service is not ready."; owner.log("UI request blocked: service not ready"); completion(nil); return }
  var r = URLRequest(url: URL(string: "http://127.0.0.1:19791" + path)!); r.timeoutInterval = 5
  r.setValue("Bearer " + owner.token, forHTTPHeaderField: "Authorization")
  if let body = body { r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try? JSONSerialization.data(withJSONObject: body) }
  owner.session.dataTask(with: r) { [weak self] data,response,error in
   let result = data.flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String:Any] }
   DispatchQueue.main.async {
    guard let self = self else { return }
    guard error == nil, let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode), let result = result else { self.owner.log("UI request failed: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0), network code \((error as NSError?)?.code ?? 0)"); self.message = result?["error"] as? String ?? "Service request failed."; completion(nil); return }
    completion(result)
   }
  }.resume()
 }
 func refresh() {
  owner.refresh(); phase = owner.state.phase; accessToken = owner.token; guard owner.state.ready else { return }
  request("/admin/config") { [weak self] c in guard let self = self, let c = c else { return }; self.loading = true; self.enabled = c["sendEnabled"] as? Bool ?? false; self.everyone = c["allowEveryone"] as? Bool ?? false; self.recipients = c["recipients"] as? [String] ?? []; self.rate = c["rateLimit"] as? Int ?? 6; self.retryCap = c["retryCap"] as? Int ?? 0; self.debug = c["debug"] as? Bool ?? false; self.relayURL = c["relayUrl"] as? String ?? ""; DispatchQueue.main.async { self.loading = false } }
  request("/v1/health") { [weak self] h in
   guard let self = self, let h = h else { return }
   if let send = h["lastSend"] as? [String:Any], let to = send["to"] as? String, let ts = send["createdAt"] as? Double {
    let state = send["state"] as? String ?? "unknown"; let date = Date(timeIntervalSince1970: ts/1000); let time = DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short)
    self.lastSend = "\(time) · \(to) · \(state == "dispatch-accepted" ? "Submitted" : "Uncertain")"
    let key = "\(ts)-\(state)"
    if state == "uncertain", self.notify, self.lastNotified != key { self.lastNotified = key; let content = UNMutableNotificationContent(); content.title = "Msgzle send uncertain"; content.body = "A send may have been attempted. Review its status before trying again."; UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) }
   }
  }
 }
 func save() { guard !loading else { return }; request("/admin/config", body: ["sendEnabled":enabled,"recipients":recipients,"allowEveryone":everyone,"rateLimit":rate,"retryCap":retryCap,"debug":debug]) { [weak self] r in if r != nil { self?.owner.log("Settings policy saved"); self?.message = "Saved" } } }
 func add(_ value: String) { let v = value.trimmingCharacters(in: .whitespacesAndNewlines); guard !v.isEmpty else { return }; if !recipients.contains(v) { recipients.append(v) }; input = ""; suggestions = []; save() }
 func remove(_ value: String) { recipients.removeAll { $0 == value }; save() }
 func search() { let q = input.lowercased(); suggestions = Array(contacts.filter { q.isEmpty || $0.0.lowercased().contains(q) || $0.1.contains(q) }.prefix(6)) }
 func loadContacts() {
  owner.log("Contacts load requested, authorization status \(CNContactStore.authorizationStatus(for: .contacts).rawValue)")
  contactsStatus = "Loading Contacts…"
  let store = CNContactStore(); store.requestAccess(for: .contacts) { [weak self] granted,_ in
   DispatchQueue.main.async { self?.owner.settingsWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true) }
   guard granted else { self?.owner.log("Contacts access not granted"); DispatchQueue.main.async { self?.contactsStatus = "Contacts access unavailable. Allow Msgzle in System Settings or enter manually." }; return }
   DispatchQueue.global(qos: .userInitiated).async {
    var list: [(String,String)] = []
    let keys = [CNContactGivenNameKey,CNContactFamilyNameKey,CNContactPhoneNumbersKey,CNContactEmailAddressesKey] as [CNKeyDescriptor]
    do { try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c,_ in
     let name = (c.givenName + " " + c.familyName).trimmingCharacters(in: .whitespaces)
     for p in c.phoneNumbers { let raw = p.value.stringValue; let number = raw.filter { $0.isNumber || $0 == "+" }; if number.hasPrefix("+") { list.append((name,number)) } }
     for e in c.emailAddresses { list.append((name,e.value as String)) }
    }; DispatchQueue.main.async { self?.owner.log("Contacts loaded, address count \(list.count)"); self?.contacts = list; self?.contactsStatus = "\(list.count) contact addresses loaded"; self?.search() } }
    catch { self?.owner.log("Contacts enumeration failed, code \((error as NSError).code)"); DispatchQueue.main.async { self?.contactsStatus = "Could not load Contacts. Manual entry still works." } }
   }
  }
 }
 func setLogin() { do { if login { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } } catch { login = SMAppService.mainApp.status == .enabled; message = "Login item could not be changed. Review System Settings." } }
 func setNotify() { UserDefaults.standard.set(notify,forKey:"notifyFailures"); if notify { UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound]) { [weak self] ok,_ in if !ok { DispatchQueue.main.async { self?.message = "Notifications are not permitted. Review System Settings." } } } } }
 func setUpdates() { owner.updater.updater.automaticallyChecksForUpdates = automaticUpdates; owner.updater.updater.automaticallyDownloadsUpdates = automaticUpdates }
 func copyToken() { let paste = NSPasteboard.general; paste.clearContents(); paste.setString(accessToken,forType:.string); let count = paste.changeCount; DispatchQueue.main.asyncAfter(deadline:.now()+60) { if paste.changeCount == count { paste.clearContents() } }; message = "Copied. Clipboard clears in 60 seconds if unchanged." }
 func pair() { request("/admin/relay",body:["url":relayURL,"token":relayToken]) { [weak self] r in if r != nil { self?.relayToken = ""; self?.message = "Relay saved" } } }
 func sendTest() { owner.log("Test send submitted to local API"); request("/v1/commands",body:["id":UUID().uuidString,"to":testRecipient,"text":testText]) { [weak self] r in if r != nil { self?.owner.log("Test command queued"); self?.showTest = false; self?.message = "Test queued. Submitted does not mean delivered." } } }
}
struct SettingsView: View {
 @ObservedObject var model: SettingsModel
 @State var tab = 0
 @State var showRelay = false
 var paneHeight: CGFloat { tab == 0 && !model.everyone ? 780 : 620 }
 func resizePane() { model.owner.settingsWindow?.setContentSize(NSSize(width:460,height:paneHeight)) }
 @ViewBuilder func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
  VStack(alignment:.leading,spacing:8) {
   Text(title).font(.system(size:10,weight:.semibold)).foregroundStyle(.secondary).padding(.leading,4)
   VStack(alignment:.leading,spacing:0) { content() }.padding(.horizontal,14).background(Color(nsColor:.controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius:10))
  }
 }
 @ViewBuilder func row<Content: View>(@ViewBuilder content: () -> Content) -> some View { HStack(spacing:12) { content() }.frame(minHeight:38) }
 @ViewBuilder func switchRow(_ title: String, value: Binding<Bool>, changed: @escaping () -> Void) -> some View {
  row { Text(title); Spacer(); Toggle(title,isOn:value).labelsHidden().fixedSize().onChange(of:value.wrappedValue) { _ in changed() } }
 }
 var general: some View {
  VStack(alignment:.leading,spacing:20) {
   section("SERVICE") {
    row { Text("● " + model.phase).fontWeight(.semibold).foregroundStyle(model.phase == "Running" ? Color.green : model.phase == "Stopped" ? Color.red : Color.secondary); Spacer(); Button { model.refresh() } label: { Image(systemName:"arrow.clockwise") }.buttonStyle(.borderless).help("Refresh status").accessibilityLabel("Refresh status"); Button(model.owner.service?.isRunning == true ? "Stop" : "Start") { model.owner.toggleService(); model.refresh() }.frame(width:58) }
    Divider()
    row { Text("Last send").foregroundStyle(.secondary); Text(model.lastSend).font(.system(size:11)).lineLimit(1).truncationMode(.middle).help(model.lastSend); Spacer(minLength:0); Button("Test…") { model.message = ""; model.owner.log("Test review opened"); model.showTest = true }.frame(width:58) }
   }
   section("SENDING") {
    switchRow("Enable sends",value:$model.enabled) { model.save() }
    Divider()
    row { Text("Recipients"); Spacer(); Picker("Recipients",selection:$model.everyone) { Text("Selected recipients").tag(false); Text("Everyone").tag(true) }.labelsHidden().fixedSize().onChange(of:model.everyone) { _ in model.save() } }
    if !model.everyone {
     Divider()
     HStack { TextField("Search Contacts or enter a recipient",text:$model.input).onChange(of:model.input) { _ in model.search() }; Button { model.add(model.input) } label: { Image(systemName:"plus") }.help("Add recipient") }.padding(.vertical,10)
     ScrollView {
      LazyVStack(alignment:.leading,spacing:8) {
       ForEach(Array(model.suggestions.enumerated()),id:\.offset) { _,item in Button { model.add(item.1) } label: { HStack { VStack(alignment:.leading,spacing:2) { Text(item.0).fontWeight(.medium); Text(item.1).font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName:"plus.circle").foregroundStyle(.secondary) } }.buttonStyle(.plain) }
       ForEach(model.recipients,id:\.self) { item in HStack { Text(item); Spacer(); Button { model.remove(item) } label: { Image(systemName:"minus.circle") }.buttonStyle(.borderless) } }
      }.padding(.vertical,4)
     }.frame(height:90)
     row { Text(model.contactsStatus).font(.system(size:10)).foregroundStyle(.secondary).lineLimit(2); Spacer(); Button { model.loadContacts() } label: { Image(systemName:"arrow.clockwise") }.buttonStyle(.borderless).help("Reload Contacts") }
    }
   }
   section("PREFERENCES") {
    switchRow("Launch at login",value:$model.login) { model.setLogin() }
    Divider()
    switchRow("Notify on uncertain sends",value:$model.notify) { model.setNotify() }
    Divider()
    switchRow("Automatic updates",value:$model.automaticUpdates) { model.setUpdates() }
   }
  }
 }
 var advanced: some View {
  VStack(alignment:.leading,spacing:22) {
   section("API ACCESS") {
    VStack(alignment:.leading,spacing:12) {
     Text("SDK access token").fontWeight(.semibold)
     HStack(alignment:.center,spacing:10) { Text(model.reveal ? model.accessToken : "•••• •••• •••• ••••").font(.system(size:11,design:.monospaced)).lineLimit(2).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading); Button(model.reveal ? "Hide" : "Reveal") { model.reveal.toggle() }; Button("Copy") { model.copyToken() } }
    }.padding(.vertical,14)
   }
   section("DISPATCH SAFETY") {
    VStack(alignment:.leading,spacing:6) {
     row { Text("Pre-dispatch checks"); Spacer(); Text(model.retryCap == 0 ? "Off" : String(model.retryCap)).foregroundStyle(.secondary); Stepper("Pre-dispatch checks",value:$model.retryCap,in:0...3).labelsHidden().fixedSize().onChange(of:model.retryCap) { _ in model.save() } }
     Text("Only retries the Messages-running check. Never retries a send.").font(.system(size:11)).foregroundStyle(.secondary)
    }.padding(.vertical,12)
    Divider()
    row { Text("Send rate"); Spacer(); Text("\(model.rate) / minute").foregroundStyle(.secondary); Stepper("Send rate",value:$model.rate,in:1...120).labelsHidden().fixedSize().onChange(of:model.rate) { _ in model.save() } }
   }
   section("DIAGNOSTICS") {
    switchRow("Debug diagnostics",value:$model.debug) { model.save() }
   }
   section("CLOUD RELAY") {
    row { Text(model.relayURL.isEmpty ? "Not configured" : "Configured").foregroundStyle(.secondary); Spacer(); Button("Set up…") { model.message = ""; showRelay = true } }
   }
   Text("Logs omit message text, tokens and contact data. Receive and webhooks are not included in v0.").font(.system(size:11)).foregroundStyle(.secondary).padding(.horizontal,4)
  }
 }
 var body: some View {
  VStack(alignment:.leading,spacing:20) {
   Picker("Pane",selection:$tab) { Text("General").tag(0); Text("Advanced").tag(1) }.pickerStyle(.segmented).labelsHidden().frame(width:244).frame(maxWidth:.infinity).padding(.bottom,2)
   if tab == 0 { general } else { advanced }
   Spacer(minLength:0)
   if !model.message.isEmpty { Text(model.message).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2) }
   VStack(spacing:12) { Divider(); HStack(spacing:16) { Button("Open Logs") { model.owner.openLogs() }; Button("Check Updates") { model.owner.checkUpdates() }; Spacer(); Text(model.version).font(.system(size:10)).foregroundStyle(.secondary) }.buttonStyle(.link).font(.system(size:11)) }
  }.padding(24).frame(width:460,height:paneHeight).font(.system(size:12)).toggleStyle(.switch).background(Color(nsColor:.windowBackgroundColor))
  .onAppear { model.refresh(); resizePane() }.onChange(of:tab) { _ in resizePane() }.onChange(of:model.everyone) { _ in resizePane() }.onDisappear { model.reveal = false }
  .sheet(isPresented:$model.showTest) {
   VStack(alignment:.leading,spacing:14) {
    Text("Review test message").font(.headline)
    TextField("Recipient: +number or email",text:$model.testRecipient)
    TextField("Message",text:$model.testText)
    if !model.message.isEmpty { Text(model.message).font(.caption).foregroundStyle(.red) }
    Text("This sends a real message using Messages. Sending must be enabled and the recipient permitted.").font(.caption).foregroundStyle(.secondary)
    HStack { Button("Cancel") { model.owner.log("Test send cancelled before submission"); model.showTest = false }; Spacer(); Button("Send") { model.sendTest() }.disabled(model.testRecipient.isEmpty || model.testText.isEmpty) }
   }.padding(24).frame(width:380)
  }
  .sheet(isPresented:$showRelay) {
   VStack(alignment:.leading,spacing:14) {
    Text("Cloud relay").font(.headline)
    TextField("HTTPS relay URL",text:$model.relayURL)
    SecureField("Connector token",text:$model.relayToken)
    if !model.message.isEmpty { Text(model.message).font(.caption).foregroundStyle(.secondary) }
    HStack { Button("Close") { model.relayToken = ""; showRelay = false }; Spacer(); Button("Save relay") { model.pair() } }
   }.padding(24).frame(width:380)
  }
 }
}
