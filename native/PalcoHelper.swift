// Palco Helper: the only part of Palco that touches other apps.
// It runs as its own app bundle so macOS asks for Accessibility / Screen Recording for
// "Palco Helper" alone, never for the whole Node runtime.
//
// Usage: palco-helper <request.json> <response.json>
// Request:  {"cmd": "...", ...args}
// Response: {"ok": true, "out": "..."} or {"ok": false, "error": "..."}

import AppKit
import ApplicationServices
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

struct Fail: Error { let message: String }

let home = FileManager.default.homeDirectoryForCurrentUser
var palcoHome = ProcessInfo.processInfo.environment["PALCO_HOME"].map { URL(fileURLWithPath: $0) }
  ?? home.appendingPathComponent(".palco")
var refsDir: URL { palcoHome.appendingPathComponent("computer") }

// MARK: - Accessibility helpers

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = attr(el, name) else { return nil }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}

func requireTrust() throws {
  let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  if !AXIsProcessTrustedWithOptions(opts) {
    throw Fail(message: "O Palco Helper ainda não tem permissão de Acessibilidade. Abra Ajustes do Sistema > Privacidade e Segurança > Acessibilidade, ative \"Palco Helper\" e tente de novo.")
  }
}

func runningApp(_ name: String) throws -> NSRunningApplication {
  let lower = name.lowercased()
  let apps = NSWorkspace.shared.runningApplications
  if let a = apps.first(where: { $0.localizedName?.lowercased() == lower || $0.bundleIdentifier?.lowercased() == lower }) { return a }
  if let a = apps.first(where: { ($0.localizedName?.lowercased() ?? "").contains(lower) && $0.activationPolicy == .regular }) { return a }
  throw Fail(message: "App \"\(name)\" não está aberto. Use: palco computer open \"\(name)\"")
}

func rootWindow(_ app: NSRunningApplication) throws -> AXUIElement {
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  if let w = attr(ax, kAXFocusedWindowAttribute) { return (w as! AXUIElement) }
  if let ws = attr(ax, kAXWindowsAttribute) as? [AXUIElement], let w = ws.first { return w }
  throw Fail(message: "\(app.localizedName ?? "App") não tem janela aberta.")
}

let interesting: Set<String> = [
  "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
  "AXLink", "AXTab", "AXComboBox", "AXSlider", "AXSearchField", "AXCell", "AXRow", "AXMenuItem",
  "AXStaticText", "AXHeading", "AXImage", "AXDisclosureTriangle", "AXIncrementor", "AXSecureTextField",
]

struct RefMap: Codable { var pid: Int32; var refs: [String: [Int]] }

func refsFile(_ pid: pid_t) -> URL { refsDir.appendingPathComponent("refs-\(pid).json") }

func snapshot(_ appName: String) throws -> String {
  try requireTrust()
  let app = try runningApp(appName)
  let win = try rootWindow(app)
  var lines: [String] = ["# \(app.localizedName ?? appName) — \(str(win, kAXTitleAttribute) ?? "(sem título)")"]
  var refs: [String: [Int]] = [:]
  var n = 0
  func walk(_ el: AXUIElement, _ path: [Int], _ depth: Int) {
    if n >= 400 || depth > 30 { return }
    let role = str(el, kAXRoleAttribute) ?? "?"
    if interesting.contains(role) {
      let label = [str(el, kAXTitleAttribute), str(el, kAXDescriptionAttribute), str(el, kAXHelpAttribute), str(el, kAXPlaceholderValueAttribute)]
        .compactMap { $0 }.first { !$0.isEmpty } ?? ""
      let value = role == "AXSecureTextField" ? "" : (str(el, kAXValueAttribute) ?? "")
      let text = role == "AXStaticText" ? (value.isEmpty ? label : value) : label
      if !(role == "AXStaticText" && text.trimmingCharacters(in: .whitespaces).isEmpty) {
        n += 1
        let ref = "e\(n)"
        refs[ref] = path
        var line = "\(String(repeating: "  ", count: min(depth, 8)))- \(role.replacingOccurrences(of: "AX", with: "").lowercased()) \"\(text.prefix(80))\""
        if role != "AXStaticText" && !value.isEmpty { line += " value=\"\(value.prefix(60))\"" }
        if let e = attr(el, kAXEnabledAttribute) as? Bool, !e { line += " [disabled]" }
        lines.append(line + " @\(ref)")
      }
    }
    for (i, c) in children(el).enumerated() { walk(c, path + [i], depth + 1) }
  }
  walk(win, [], 0)
  if n >= 400 { lines.append("- … (truncado em 400 elementos)") }
  try FileManager.default.createDirectory(at: refsDir, withIntermediateDirectories: true)
  try JSONEncoder().encode(RefMap(pid: app.processIdentifier, refs: refs)).write(to: refsFile(app.processIdentifier))
  return lines.joined(separator: "\n")
}

func resolve(_ appName: String, _ ref: String) throws -> AXUIElement {
  try requireTrust()
  let app = try runningApp(appName)
  let key = ref.replacingOccurrences(of: "@", with: "")
  guard let data = try? Data(contentsOf: refsFile(app.processIdentifier)),
        let map = try? JSONDecoder().decode(RefMap.self, from: data),
        let path = map.refs[key] else {
    throw Fail(message: "Referência \(ref) desconhecida. Rode `palco computer snapshot \"\(appName)\"` primeiro.")
  }
  var el = try rootWindow(app)
  for i in path {
    let cs = children(el)
    guard i < cs.count else { throw Fail(message: "A janela mudou desde o snapshot. Rode o snapshot de novo.") }
    el = cs[i]
  }
  return el
}

// MARK: - Input events

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func click(at p: CGPoint, button: CGMouseButton = .left, count: Int = 1) {
  let (down, up): (CGEventType, CGEventType) = button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button))
  for i in 1...count {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    post(d)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    post(u)
  }
}

func typeText(_ s: String) {
  for ch in s {
    let utf16 = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      post(e)
    }
    usleep(4000)
  }
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
  "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressKey(_ combo: String) throws {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd", "command", "meta": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "fn": flags.insert(.maskSecondaryFn)
    default:
      guard let k = keyCodes[part] else { throw Fail(message: "Tecla desconhecida: \(part)") }
      key = k
    }
  }
  guard let k = key else { throw Fail(message: "Informe a tecla, ex.: cmd+s, enter, esc") }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: k, keyDown: down)
    e?.flags = flags
    post(e)
  }
}

// MARK: - Commands

func capture(_ args: [String: Any]) throws -> String {
  let dir = palcoHome.appendingPathComponent("screenshots")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let out = dir.appendingPathComponent("tela-\(Int(Date().timeIntervalSince1970 * 1000)).png").path
  var argv = ["-x", "-t", "png"]
  if let app = args["app"] as? String, !app.isEmpty {
    let a = try runningApp(app)
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    guard let w = list.first(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == a.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }),
          let id = w[kCGWindowNumber as String] as? Int else { throw Fail(message: "\(app) não tem janela visível.") }
    argv += ["-o", "-l", String(id)]
  }
  argv.append(out)
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  p.arguments = argv
  try p.run()
  p.waitUntilExit()
  guard FileManager.default.fileExists(atPath: out) else {
    throw Fail(message: "A captura falhou. Ative \"Palco Helper\" em Ajustes > Privacidade e Segurança > Gravação de Tela.")
  }
  return out
}

func windows(_ app: String?) throws -> String {
  let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  var lines: [String] = []
  for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
    let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
    if let app, !owner.lowercased().contains(app.lowercased()) { continue }
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    let title = w[kCGWindowName as String] as? String ?? ""
    lines.append("- \(owner): \"\(title)\" em \(Int(b["X"] ?? 0)),\(Int(b["Y"] ?? 0)) \(Int(b["Width"] ?? 0))x\(Int(b["Height"] ?? 0))")
  }
  return lines.isEmpty ? "(nenhuma janela visível)" : lines.joined(separator: "\n")
}

func summarize(_ text: String, _ name: String) async throws -> String {
  #if canImport(FoundationModels)
  if #available(macOS 26.0, *) {
    let model = SystemLanguageModel.default
    guard case .available = model.availability else {
      throw Fail(message: "Apple Intelligence indisponível neste Mac (ative em Ajustes > Apple Intelligence).")
    }
    let session = LanguageModelSession(instructions: """
      Você acompanha agentes de programação. Recebe o fim da tela do terminal de um agente que acabou de parar.
      Responda em português do Brasil, curto, neste formato exato:
      Resumo: <uma ou duas frases sobre o que o agente fez ou está pedindo>
      Próximo passo: <uma sugestão concreta para o usuário>
      Se o agente estiver esperando uma resposta ou aprovação, diga isso no resumo.
      """)
    let r = try await session.respond(to: "Agente: \(name)\n\nTela:\n\(text.suffix(6000))")
    return r.content.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  #endif
  throw Fail(message: "Este macOS não tem o modelo local da Apple (precisa do macOS 26).")
}

func handle(_ req: [String: Any]) async throws -> String {
  let cmd = req["cmd"] as? String ?? ""
  let app = req["app"] as? String ?? ""
  switch cmd {
  case "trust":
    try requireTrust()
    return "Acessibilidade liberada para o Palco Helper."
  case "apps":
    return NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .map { "- \($0.localizedName ?? "?")\($0.isActive ? " (em foco)" : "")\($0.isHidden ? " (oculto)" : "")" }
      .joined(separator: "\n")
  case "open":
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    p.arguments = ["-a", app]
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 { throw Fail(message: "Não achei o app \"\(app)\".") }
    return "Abrindo \(app)."
  case "focus":
    let a = try runningApp(app)
    a.activate()
    return "\(a.localizedName ?? app) em foco."
  case "windows": return try windows(app.isEmpty ? nil : app)
  case "screenshot": return try capture(req)
  case "snapshot": return try snapshot(app)
  case "click":
    let el = try resolve(app, req["ref"] as? String ?? "")
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return "Pressionou \(req["ref"] ?? "")." }
    guard let f = frame(el) else { throw Fail(message: "O elemento não aceita clique.") }
    click(at: CGPoint(x: f.midX, y: f.midY))
    return "Clicou no centro de \(req["ref"] ?? "")."
  case "fill":
    let el = try resolve(app, req["ref"] as? String ?? "")
    let text = req["text"] as? String ?? ""
    if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFTypeRef) == .success { return "Preencheu \(req["ref"] ?? "")." }
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    typeText(text)
    return "Digitou em \(req["ref"] ?? "")."
  case "click-at":
    try requireTrust()
    let x = req["x"] as? Double ?? 0, y = req["y"] as? Double ?? 0
    click(at: CGPoint(x: x, y: y), button: (req["right"] as? Bool ?? false) ? .right : .left, count: (req["double"] as? Bool ?? false) ? 2 : 1)
    return "Clique em \(Int(x)),\(Int(y))."
  case "type":
    try requireTrust()
    typeText(req["text"] as? String ?? "")
    return "Digitado."
  case "key":
    try requireTrust()
    try pressKey(req["key"] as? String ?? "")
    return "Tecla \(req["key"] ?? "")."
  case "scroll":
    try requireTrust()
    if let x = req["x"] as? Double, let y = req["y"] as? Double {
      post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
    }
    let dy = Int32(req["dy"] as? Double ?? 0), dx = Int32(req["dx"] as? Double ?? 0)
    post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0))
    return "Rolou."
  case "summarize":
    return try await summarize(req["text"] as? String ?? "", req["name"] as? String ?? "agente")
  case "ping":
    return "pong"
  default:
    throw Fail(message: "Comando desconhecido: \(cmd)")
  }
}

let argv = CommandLine.arguments
guard argv.count >= 3 else {
  FileHandle.standardError.write("uso: palco-helper <request.json> <response.json>\n".data(using: .utf8)!)
  exit(2)
}
let reqURL = URL(fileURLWithPath: argv[1]), resURL = URL(fileURLWithPath: argv[2])
var response: [String: Any]
do {
  let data = try Data(contentsOf: reqURL)
  let req = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
  if let h = req["home"] as? String, !h.isEmpty { palcoHome = URL(fileURLWithPath: h) }
  response = ["ok": true, "out": try await handle(req)]
} catch let f as Fail {
  response = ["ok": false, "error": f.message]
} catch {
  response = ["ok": false, "error": "\(error)"]
}
let out = try JSONSerialization.data(withJSONObject: response)
try out.write(to: resURL, options: .atomic)
