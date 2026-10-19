import ApplicationServices
import Cocoa
import Darwin
import Foundation
import ScreenCaptureKit

let socketPath = "/tmp/yanylevin-computer-use.sock"
let pidPath = "/tmp/yanylevin-computer-use.pid"
let maxNodes = 400
let maxDepth = 12

let skipBundles: Set<String> = [
    "com.apple.Spotlight",
    "com.apple.notificationcenterui",
    "com.apple.controlcenter",
    "com.apple.TextInputMenuAgent",
    "com.apple.SystemUIServer",
]

var nextElementId = 1
var keyToId: [String: Int] = [:]
var lastPid: pid_t = 0
var lastScale: CGFloat = 1
var lastWindowOrigin = CGPoint.zero
var lastImageSize = CGSize.zero

func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    let url = URL(fileURLWithPath: "/tmp/yanylevin-computer-use.log")
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: url.path),
           let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}

func screenLocked() -> Bool {
    guard let raw = CGSessionCopyCurrentDictionary() else { return false }
    let dict = raw as NSDictionary
    if let locked = dict["CGSSessionScreenIsLocked"] as? Bool, locked { return true }
    return false
}

func promptAccessibility() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let opts = [key: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
}

func regularApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { app in
        app.activationPolicy == .regular
            && app.processIdentifier > 0
            && !skipBundles.contains(app.bundleIdentifier ?? "")
    }
}

func resolveApp(_ query: String) -> NSRunningApplication? {
    let apps = regularApps()
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if q.isEmpty {
        if lastPid > 0, let kept = apps.first(where: { $0.processIdentifier == lastPid }) {
            return kept
        }
        return NSWorkspace.shared.frontmostApplication.flatMap { front in
            apps.first { $0.processIdentifier == front.processIdentifier }
        } ?? apps.first
    }
    if let pid = pid_t(q), let match = apps.first(where: { $0.processIdentifier == pid }) {
        return match
    }
    let needle = q.lowercased()
    if let exact = apps.first(where: {
        $0.localizedName?.lowercased() == needle || $0.bundleIdentifier?.lowercased() == needle
    }) {
        return exact
    }
    return apps.first { $0.localizedName?.lowercased().contains(needle) == true }
}

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(el, 0.4)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success else { return nil }
    return value
}

func axString(_ el: AXUIElement, _ attr: String) -> String {
    guard let value = axCopy(el, attr) else { return "" }
    if let s = value as? String { return s }
    if let s = value as? NSAttributedString { return s.string }
    if let n = value as? NSNumber { return n.stringValue }
    return ""
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    guard let value = axCopy(el, kAXChildrenAttribute) else { return [] }
    let rawArray = value as CFTypeRef
    guard CFGetTypeID(rawArray) == CFArrayGetTypeID() else { return [] }
    let array = rawArray as! CFArray
    var out: [AXUIElement] = []
    out.reserveCapacity(CFArrayGetCount(array))
    for index in 0..<CFArrayGetCount(array) {
        guard let raw = CFArrayGetValueAtIndex(array, index) else { continue }
        // The array does not hand over a retain. Take one before it goes away.
        out.append(Unmanaged<AXUIElement>.fromOpaque(raw).retain().takeRetainedValue())
    }
    return out
}

func axSettable(_ el: AXUIElement) -> Bool {
    var flag = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &flag) == .success else {
        return false
    }
    return flag.boolValue
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let posRef = axCopy(el, kAXPositionAttribute),
          let sizeRef = axCopy(el, kAXSizeAttribute),
          CFGetTypeID(posRef) == AXValueGetTypeID(),
          CFGetTypeID(sizeRef) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    let pos = posRef as! AXValue
    let sz = sizeRef as! AXValue
    guard AXValueGetValue(pos, .cgPoint, &point), AXValueGetValue(sz, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func plainAction(_ name: String) -> String? {
    if name == "AXPress" || name == "AXShowMenu" && false { return nil }
    let known = [
        "AXRaise": "Raise",
        "AXShowMenu": "Show menu",
        "AXPick": "Pick",
        "AXCancel": "Cancel",
        "AXConfirm": "Confirm",
        "AXIncrement": "Increment",
        "AXDecrement": "Decrement",
        "AXScrollLeft": "Scroll Left",
        "AXScrollRight": "Scroll Right",
        "AXScrollUp": "Scroll Up",
        "AXScrollDown": "Scroll Down",
    ]
    if name == "AXPress" { return nil }
    if let label = known[name] { return label }
    var rest = name
    if rest.hasPrefix("AX") { rest.removeFirst(2) }
    var out = ""
    for ch in rest {
        if ch.isUppercase && !out.isEmpty { out.append(" ") }
        out.append(ch)
    }
    return out.isEmpty ? nil : out
}

func actionNames(_ el: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(el, &raw) == .success, let raw else { return [] }
    let names = raw as [AnyObject] as? [String] ?? []
    return names.compactMap(plainAction)
}

func axActionToken(_ label: String) -> String {
    let known = [
        "raise": "AXRaise",
        "show menu": "AXShowMenu",
        "pick": "AXPick",
        "cancel": "AXCancel",
        "confirm": "AXConfirm",
        "increment": "AXIncrement",
        "decrement": "AXDecrement",
        "scroll left": "AXScrollLeft",
        "scroll right": "AXScrollRight",
        "scroll up": "AXScrollUp",
        "scroll down": "AXScrollDown",
        "press": "AXPress",
    ]
    if let token = known[label.lowercased()] { return token }
    let parts = label.split(separator: " ").map { part -> String in
        let s = String(part)
        return s.prefix(1).uppercased() + s.dropFirst()
    }
    return "AX" + parts.joined()
}

func sameElement(_ a: AXUIElement, _ b: AXUIElement) -> Bool {
    CFEqual(a, b)
}

func clip(_ text: String, _ limit: Int) -> String {
    if text.count <= limit { return text }
    return String(text.prefix(limit)) + "…"
}

struct WalkResult {
    var elements: [[String: Any]] = []
    var omittedOn: Int?
}

func remember(role: String, name: String, identifier: String, depth: Int, sibling: Int) -> Int {
    let key = "\(depth)|\(sibling)|\(role)|\(identifier)|\(name)"
    let id = keyToId[key] ?? {
        let n = nextElementId
        nextElementId += 1
        keyToId[key] = n
        return n
    }()
    return id
}

func walkTree(app: AXUIElement, root: AXUIElement, onElement: ((Int, AXUIElement, String) -> Void)? = nil) -> [[String: Any]] {
    var focusedEl: AXUIElement?
    if let raw = axCopy(app, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
        focusedEl = (raw as! AXUIElement)
    }
    var rows: [[String: Any]] = []
    var seen = Set<Int>()

    let started = Date()
    func visit(_ el: AXUIElement, parent: Int?, depth: Int, sibling: Int) {
        if rows.count >= maxNodes || depth > maxDepth { return }
        if Date().timeIntervalSince(started) > 5 { return }
        let role = axString(el, kAXRoleDescriptionAttribute)
        let roleToken = role.isEmpty ? axString(el, kAXRoleAttribute) : role
        let name = clip(axString(el, kAXTitleAttribute).isEmpty
            ? axString(el, kAXDescriptionAttribute)
            : axString(el, kAXTitleAttribute), 120)
        let identifier = axString(el, kAXIdentifierAttribute)
        let id = remember(role: roleToken, name: name, identifier: identifier, depth: depth, sibling: sibling)
        if seen.contains(id) { return }
        seen.insert(id)
        let valueRaw = axString(el, kAXValueAttribute)
        onElement?(id, el, valueRaw)
        var valueType = ""
        if let raw = axCopy(el, kAXValueAttribute) {
            if raw is String || raw is NSAttributedString { valueType = "string" }
            else if let n = raw as? NSNumber {
                valueType = CFGetTypeID(raw) == CFBooleanGetTypeID() ? "bool" : (n.doubleValue.rounded() == n.doubleValue ? "number" : "float")
                if CFGetTypeID(raw) == CFBooleanGetTypeID() { valueType = "bool" }
            }
        }
        let enabled = axCopy(el, kAXEnabledAttribute) as? NSNumber
        var row: [String: Any] = [
            "id": id,
            "depth": depth,
            "role": roleToken.isEmpty ? "element" : roleToken,
            "name": name,
            "value": clip(valueRaw, 400),
            "valueType": valueType,
            "settable": axSettable(el),
            "disabled": enabled?.boolValue == false,
            "help": clip(axString(el, kAXHelpAttribute), 160),
            "identifier": identifier,
            "actions": actionNames(el),
            "focused": focusedEl != nil && sameElement(el, focusedEl!),
        ]
        if let parent { row["parent"] = parent }
        let kids = axChildren(el)
        let room = maxNodes - rows.count - 1
        if kids.count > room && room >= 0 {
            row["omitted"] = kids.count - max(room, 0)
        }
        rows.append(row)
        let limit = min(kids.count, max(0, maxNodes - rows.count))
        for index in 0..<limit {
            visit(kids[index], parent: id, depth: depth + 1, sibling: index)
        }
    }

    visit(root, parent: nil, depth: 0, sibling: 0)
    return rows
}

func cgPointFromTop(ax: CGPoint) -> CGPoint {
    let height = NSScreen.screens.map { $0.frame.maxY }.max() ?? ax.y
    return CGPoint(x: ax.x, y: height - ax.y)
}

func jpegData(_ image: CGImage, bounds: CGRect) -> (data: Data, size: CGSize)? {
    let cap: CGFloat = 900
    let longest = max(CGFloat(image.width), CGFloat(image.height), 1)
    let scale = min(1, cap / longest)
    let w = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let h = max(1, Int((CGFloat(image.height) * scale).rounded()))
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.interpolationQuality = CGInterpolationQuality.medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let scaled = ctx.makeImage() else { return nil }
    let rep = NSBitmapImageRep(cgImage: scaled)
    guard let jpeg = rep.representation(using: .jpeg, properties: [
        NSBitmapImageRep.PropertyKey.compressionFactor: 0.45,
    ]) else { return nil }
    lastScale = CGFloat(w) / max(bounds.width, 1)
    lastWindowOrigin = bounds.origin
    lastImageSize = CGSize(width: w, height: h)
    return (jpeg, CGSize(width: w, height: h))
}

func captureWindow(pid: pid_t, title: String) -> (data: Data, size: CGSize, origin: CGPoint)? {
    let sem = DispatchSemaphore(value: 0)
    var shot: (data: Data, size: CGSize, origin: CGPoint)?
    Task.detached {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let owned = content.windows.filter { $0.owningApplication?.processID == pid }
            let match = owned.first { $0.title == title && !title.isEmpty } ?? owned.first { $0.isOnScreen } ?? owned.first
            guard let window = match else { return }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = max(1, Int(window.frame.width.rounded()))
            config.height = max(1, Int(window.frame.height.rounded()))
            config.showsCursor = false
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let bounds = CGRect(origin: window.frame.origin, size: window.frame.size)
            if let jpeg = jpegData(image, bounds: bounds) {
                shot = (jpeg.data, jpeg.size, bounds.origin)
            }
        } catch {
            log("capture \(error)")
        }
    }
    _ = sem.wait(timeout: .now() + 8)
    return shot
}

func imagePointToCG(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    let ax = CGPoint(
        x: lastWindowOrigin.x + (x / max(lastScale, 0.01)),
        y: lastWindowOrigin.y + (y / max(lastScale, 0.01))
    )
    return cgPointFromTop(ax: ax)
}

func postMouse(pid: pid_t, type: CGEventType, point: CGPoint, button: CGMouseButton) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let event = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
    event.postToPid(pid)
}

func clickPoint(pid: pid_t, point: CGPoint, button: CGMouseButton, count: Int) {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    for _ in 0..<max(count, 1) {
        postMouse(pid: pid, type: down, point: point, button: button)
        postMouse(pid: pid, type: up, point: point, button: button)
        usleep(30_000)
    }
}

func elementCenterCG(_ el: AXUIElement) -> CGPoint? {
    guard let frame = axFrame(el) else { return nil }
    let mid = CGPoint(x: frame.midX, y: frame.midY)
    return cgPointFromTop(ax: mid)
}

func pressElement(_ el: AXUIElement, pid: pid_t) -> String? {
    if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success { return nil }
    guard let point = elementCenterCG(el) else { return "no frame for a pixel click" }
    clickPoint(pid: pid, point: point, button: .left, count: 1)
    return nil
}

func focusElement(_ el: AXUIElement) {
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}

func activatePid(_ pid: pid_t) {
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    if let raw = axCopy(ax, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
        AXUIElementPerformAction(raw as! AXUIElement, kAXRaiseAction as CFString)
    }
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    usleep(80_000)
}

func typeUnicode(pid: pid_t, text: String) {
    if text.isEmpty { return }
    activatePid(pid)
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return }
    units.withUnsafeBufferPointer { ptr in
        guard let base = ptr.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
    }
    down.postToPid(pid)
    up.postToPid(pid)
}

func keyCode(_ name: String) -> CGKeyCode? {
    let map: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "escape": 53, "esc": 53,
        "space": 49, "delete": 51, "backspace": 51, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
        "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    ]
    return map[name.lowercased()]
}

func postKey(pid: pid_t, spec: String) {
    let parts = spec.split { $0 == "+" || $0 == "-" }.map { String($0).trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    guard let last = parts.last, let code = keyCode(last == "meta" ? "command" : last) else { return }
    activatePid(pid)
    var flags = CGEventFlags()
    for part in parts.dropLast() {
        switch part {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: break
        }
    }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    up.postToPid(pid)
}

func jsonInt(_ value: Any?) -> Int? {
    if let n = value as? Int { return n }
    if let n = value as? NSNumber { return n.intValue }
    return nil
}

func performOnElement(_ body: [String: Any], _ action: @escaping (AXUIElement, pid_t, String) -> [String: Any]) -> [String: Any] {
    if screenLocked() { return ["ok": false, "error": "screen locked"] }
    let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
    let id = jsonInt(body["id"]) ?? jsonInt(body["element_index"]) ?? 0
    guard pid > 0 else { return ["ok": false, "error": "missing pid"] }
    lastPid = pid
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(ax, 1)
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let focusedWindow = axCopy(ax, kAXFocusedWindowAttribute).flatMap { raw -> AXUIElement? in
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }
    let root = focusedWindow ?? axChildren(ax).first ?? ax
    var reply: [String: Any]? = nil
    _ = walkTree(app: ax, root: root) { found, el, value in
        if found == id && reply == nil {
            reply = action(el, pid, value)
        }
    }
    return reply ?? ["ok": false, "error": "snapshot stale, call get_app_state"]
}

func appsPayload() -> [String: Any] {
    let apps = regularApps().map { app -> [String: Any] in
        [
            "name": app.localizedName ?? "",
            "bundleId": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
            "path": app.bundleURL?.path ?? "",
            "frontmost": app.isActive,
        ]
    }
    return ["ok": true, "apps": apps]
}

func statePayload(_ body: [String: Any]) -> [String: Any] {
    log("state begin")
    if screenLocked() {
        log("locked")
        return ["ok": false, "error": "screen locked"]
    }
    let query = body["app"] as? String ?? ""
    guard let app = resolveApp(query) else {
        log("no app")
        return ["ok": false, "error": "app not running"]
    }
    let pid = app.processIdentifier
    lastPid = pid
    log("pid \(pid)")
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(ax, 1)
    log("ax app")
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    log("manual")
    let focusedWindow = axCopy(ax, kAXFocusedWindowAttribute).flatMap { raw -> AXUIElement? in
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }
    log("focused window \(focusedWindow != nil)")
    let windowEl = focusedWindow ?? axChildren(ax).first ?? ax
    let title = axString(windowEl, kAXTitleAttribute)
    log("title \(title)")
    let rows = walkTree(app: ax, root: windowEl)
    log("walk \(rows.count)")
    var payload: [String: Any] = [
        "ok": true,
        "app": app.localizedName ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": Int(pid),
        "path": app.bundleURL?.path ?? "",
        "window": title,
        "elements": rows,
    ]
    if let shot = captureWindow(pid: pid, title: title) {
        log("shot \(shot.data.count)")
        payload["jpeg"] = shot.data.base64EncodedString()
        payload["imageWidth"] = Int(shot.size.width)
        payload["imageHeight"] = Int(shot.size.height)
    } else {
        log("no shot")
        payload["screenshotError"] = "no window image (Screen Recording may be off for this helper)"
    }
    log("state done")
    return payload
}

func clickPayload(_ body: [String: Any]) -> [String: Any] {
    if screenLocked() { return ["ok": false, "error": "screen locked"] }
    let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
    if jsonInt(body["id"]) == nil && jsonInt(body["element_index"]) == nil,
       let x = (body["x"] as? NSNumber)?.doubleValue,
       let y = (body["y"] as? NSNumber)?.doubleValue {
        guard pid > 0 else { return ["ok": false, "error": "missing pid"] }
        guard lastImageSize.width > 0 else { return ["ok": false, "error": "no screenshot yet"] }
        let point = imagePointToCG(CGFloat(x), CGFloat(y))
        let button: CGMouseButton = (body["button"] as? String) == "right" ? .right : .left
        let count = jsonInt(body["count"]) ?? 1
        clickPoint(pid: pid, point: point, button: button, count: count)
        return ["ok": true]
    }
    return performOnElement(body) { el, pid, _ in
        if let err = pressElement(el, pid: pid) { return ["ok": false, "error": err] }
        return ["ok": true]
    }
}

func typePayload(_ body: [String: Any]) -> [String: Any] {
    if screenLocked() { return ["ok": false, "error": "screen locked"] }
    let text = body["text"] as? String ?? ""
    let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
    if jsonInt(body["id"]) != nil || jsonInt(body["element_index"]) != nil {
        let focused = performOnElement(body) { el, _, _ in
            focusElement(el)
            return ["ok": true]
        }
        if focused["ok"] as? Bool != true { return focused }
        usleep(40_000)
    }
    guard pid > 0 else { return ["ok": false, "error": "missing pid"] }
    typeUnicode(pid: pid, text: text)
    return ["ok": true]
}

func keyPayload(_ body: [String: Any]) -> [String: Any] {
    if screenLocked() { return ["ok": false, "error": "screen locked"] }
    let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
    guard pid > 0 else { return ["ok": false, "error": "missing pid"] }
    let spec = body["key"] as? String ?? ""
    if keyCode(spec.split(separator: "+").last.map(String.init)?.lowercased() ?? "") == nil
        && keyCode(spec.lowercased()) == nil {
        return ["ok": false, "error": "unknown key"]
    }
    postKey(pid: pid, spec: spec)
    return ["ok": true]
}

func scrollPayload(_ body: [String: Any]) -> [String: Any] {
    let pages = body["pages"] as? Double ?? 1
    return performOnElement(body) { el, pid, _ in
    let label = pages >= 0 ? "AXScrollDown" : "AXScrollUp"
    let ticks = max(1, Int((abs(pages) * 3).rounded()))
    var acted = false
    for _ in 0..<ticks {
        if AXUIElementPerformAction(el, label as CFString) == .success { acted = true }
    }
    if acted { return ["ok": true] }
    guard let point = elementCenterCG(el) else { return ["ok": false, "error": "no frame to scroll"] }
    let src = CGEventSource(stateID: .hidSystemState)
    guard let event = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: Int32(-pages * 6), wheel2: 0, wheel3: 0) else {
        return ["ok": false, "error": "scroll event failed"]
    }
    event.location = point
    event.postToPid(pid)
    return ["ok": true]
    }
}

func dragPayload(_ body: [String: Any]) -> [String: Any] {
    if screenLocked() { return ["ok": false, "error": "screen locked"] }
    let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
    guard pid > 0 else { return ["ok": false, "error": "missing pid"] }
    guard lastImageSize.width > 0 else { return ["ok": false, "error": "no screenshot yet"] }
    let x1 = CGFloat(body["x"] as? Double ?? 0)
    let y1 = CGFloat(body["y"] as? Double ?? 0)
    let x2 = CGFloat(body["toX"] as? Double ?? x1)
    let y2 = CGFloat(body["toY"] as? Double ?? y1)
    let start = imagePointToCG(x1, y1)
    let end = imagePointToCG(x2, y2)
    postMouse(pid: pid, type: .leftMouseDown, point: start, button: .left)
    for step in 1...5 {
        let t = CGFloat(step) / 5
        let mid = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        postMouse(pid: pid, type: .leftMouseDragged, point: mid, button: .left)
        usleep(16_000)
    }
    postMouse(pid: pid, type: .leftMouseUp, point: end, button: .left)
    return ["ok": true]
}

func setValuePayload(_ body: [String: Any]) -> [String: Any] {
    let value = body["value"] as? String ?? ""
    return performOnElement(body) { el, _, walked in
        let direct = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
        if direct == .success { return ["ok": true] }
        // NSTextView reports the value as settable and then refuses AXValue.
        // Select the whole string and write AXSelectedText instead.
        focusElement(el)
        let hay = walked.isEmpty ? axString(el, kAXValueAttribute) : walked
        var cf = CFRange(location: 0, length: (hay as NSString).length)
        if let boxed = AXValueCreate(.cfRange, &cf) {
            _ = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, boxed)
        }
        let selected = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, value as CFString)
        if selected == .success { return ["ok": true] }
        return ["ok": false, "error": "set value failed (\(direct.rawValue), selected \(selected.rawValue))"]
    }
}

func actionPayload(_ body: [String: Any]) -> [String: Any] {
    let name = body["name"] as? String ?? "Press"
    return performOnElement(body) { el, _, _ in
        let token = axActionToken(name)
        let err = AXUIElementPerformAction(el, token as CFString)
        if err != .success { return ["ok": false, "error": "action failed (\(err.rawValue))"] }
        return ["ok": true]
    }
}

func selectPayload(_ body: [String: Any]) -> [String: Any] {
    let needle = body["text"] as? String ?? ""
    return performOnElement(body) { el, _, walked in
        let hay = walked.isEmpty ? axString(el, kAXValueAttribute) : walked
        guard let range = hay.range(of: needle) else {
            return ["ok": false, "error": "text not in the control: \(clip(hay, 80))"]
        }
        let loc = hay.distance(from: hay.startIndex, to: range.lowerBound)
        let len = hay.distance(from: range.lowerBound, to: range.upperBound)
        var cf = CFRange(location: loc, length: len)
        guard let boxed = AXValueCreate(.cfRange, &cf) else { return ["ok": false, "error": "range failed"] }
        let err = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, boxed)
        if err != .success { return ["ok": false, "error": "select failed (\(err.rawValue))"] }
        return ["ok": true]
    }
}

func handle(_ body: [String: Any]) -> [String: Any] {
    let cmd = body["cmd"] as? String ?? ""
    log("cmd \(cmd)")
    var reply: [String: Any]
    switch cmd {
    case "apps": reply = appsPayload()
    case "state": reply = statePayload(body)
    case "click": reply = clickPayload(body)
    case "type": reply = typePayload(body)
    case "key": reply = keyPayload(body)
    case "scroll": reply = scrollPayload(body)
    case "drag": reply = dragPayload(body)
    case "set_value": reply = setValuePayload(body)
    case "action": reply = actionPayload(body)
    case "select": reply = selectPayload(body)
    default: reply = ["ok": false, "error": "unknown command"]
    }
    if let id = body["id"] { reply["id"] = id }
    return reply
}

func jsonLine(_ obj: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let text = String(data: data, encoding: .utf8) else { return #"{"ok":false,"error":"encode"}"# }
    return text
}

func readLine(fd: Int32) -> String? {
    var data = Data()
    var buf = [UInt8](repeating: 0, count: 8192)
    while data.count < 2_000_000 {
        let n = read(fd, &buf, buf.count)
        if n < 0 { return nil }
        if n == 0 { break }
        if let idx = buf[0..<n].firstIndex(of: 10) {
            data.append(contentsOf: buf[0..<idx])
            return String(data: data, encoding: .utf8)
        }
        data.append(contentsOf: buf[0..<n])
    }
    return String(data: data, encoding: .utf8)
}

func writeLine(fd: Int32, _ text: String) {
    var bytes = Array(text.utf8)
    bytes.append(10)
    var off = 0
    while off < bytes.count {
        let n = bytes[off...].withUnsafeBufferPointer { ptr -> Int in
            guard let base = ptr.baseAddress else { return -1 }
            return write(fd, base, ptr.count)
        }
        if n <= 0 { return }
        off += n
    }
}

func bindUnix(_ fd: Int32, _ path: String) -> Int32 {
    unlink(path)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let copied = path.withCString { src -> Bool in
        withUnsafeMutablePointer(to: &addr.sun_path) { dst in
            let raw = UnsafeMutableRawPointer(dst).assumingMemoryBound(to: CChar.self)
            strlcpy(raw, src, 104)
        }
        return true
    }
    if !copied { return -1 }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    return withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            Darwin.bind(fd, sa, len)
        }
    }
}

func serve() {
    _ = NSApplication.shared
    NSApplication.shared.setActivationPolicy(.prohibited)
    promptAccessibility()
    try? String(getpid()).write(toFile: pidPath, atomically: true, encoding: .utf8)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 {
        log("socket failed")
        exit(1)
    }
    if bindUnix(fd, socketPath) != 0 {
        log("bind failed")
        exit(1)
    }
    if listen(fd, 8) != 0 {
        log("listen failed")
        exit(1)
    }
    DispatchQueue.global(qos: .userInitiated).async {
        while true {
            let conn = accept(fd, nil, nil)
            if conn < 0 { continue }
            defer { close(conn) }
            guard let line = readLine(fd: conn),
                  let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                writeLine(fd: conn, #"{"ok":false,"error":"bad request"}"#)
                continue
            }
            writeLine(fd: conn, jsonLine(handle(obj)))
        }
    }
    RunLoop.main.run()
}

if CommandLine.arguments.contains("serve") {
    serve()
} else {
    fputs("usage: computer-use serve\n", stderr)
    exit(2)
}
