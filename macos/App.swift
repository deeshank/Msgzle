import Cocoa
import Sparkle
final class AppDelegate: NSObject, NSApplicationDelegate {
 var status: NSStatusItem!
 var service: Process?
 var updater: SPUStandardUpdaterController!
 func applicationDidFinishLaunching(_ notification: Notification) {
  guard let resource = Bundle.main.resourceURL else { NSApp.terminate(nil); return }
  let process = Process(); process.executableURL=resource.appendingPathComponent("msgzle-server")
  process.environment=ProcessInfo.processInfo.environment.merging(["MSGZLE_ROLE":"mac"]){_,new in new}
  do { try process.run(); service=process } catch { let alert=NSAlert();alert.messageText="Msgzle could not start";alert.informativeText="The local service did not launch. No messages were sent.";alert.runModal() }
  status=NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength);status.button?.title="Msgzle"
  let menu=NSMenu();menu.addItem(withTitle:"Open setup",action:#selector(openSetup),keyEquivalent:"")
  menu.addItem(withTitle:"Check for updates",action:#selector(checkUpdates),keyEquivalent:"")
  menu.addItem(.separator());menu.addItem(withTitle:"Quit Msgzle",action:#selector(quit),keyEquivalent:"q");status.menu=menu
  updater=SPUStandardUpdaterController(startingUpdater:true,updaterDelegate:nil,userDriverDelegate:nil)
  openSetup()
 }
 @objc func openSetup(){NSWorkspace.shared.open(URL(string:"http://127.0.0.1:19791")!)}
 @objc func checkUpdates(){updater.checkForUpdates(nil)}
 @objc func quit(){NSApp.terminate(nil)}
 func applicationWillTerminate(_ notification:Notification){service?.terminate()}
}
let app=NSApplication.shared;let delegate=AppDelegate();app.delegate=delegate;app.setActivationPolicy(.accessory);app.run()
