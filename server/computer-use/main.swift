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
var lastWindowSize = CGSize.zero
var lastWindowID: CGWindowID = 0
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
    if name == "AXPress" || name == "AXRaise" { return nil }
    let known = [
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
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            let owned = content.windows.filter { $0.owningApplication?.processID == pid }
            let titled = owned.filter { $0.title == title && !title.isEmpty }
            let popovers = owned.filter { window in
                let frame = window.frame
                let name = window.title ?? ""
                return name.isEmpty && frame.width > 200 && frame.width < 700 && frame.height > 200 && frame.height < 900
            }.sorted { $0.frame.minX < $1.frame.minX }
            // A titled window often fails to capture while a popover is up. Try each until one images.
            for window in popovers + titled {
                do {
                    let filter = SCContentFilter(desktopIndependentWindow: window)
                    let config = SCStreamConfiguration()
                    config.width = max(1, Int(window.frame.width.rounded()))
                    config.height = max(1, Int(window.frame.height.rounded()))
                    config.showsCursor = false
                    config.captureResolution = .best
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                    let bounds = CGRect(origin: window.frame.origin, size: window.frame.size)
                    if let jpeg = jpegData(image, bounds: bounds) {
                        lastWindowID = window.windowID
                        lastWindowSize = window.frame.size
                        shot = (jpeg.data, jpeg.size, bounds.origin)
                        log("shot \(window.windowID) \(Int(window.frame.width))x\(Int(window.frame.height))")
                        return
                    }
                } catch {
                    log("capture \(window.windowID) \(error)")
                }
            }
        } catch {
            log("capture \(error)")
        }
    }
    _ = sem.wait(timeout: .now() + 15)
    return shot
}

func imagePointToCG(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
    let scale = max(lastScale, 0.01)
    // SCWindow.frame origin is the top-left of the window. CGEvent location is bottom-left global.
    let ax = CGPoint(
        x: lastWindowOrigin.x + (x / scale),
        y: lastWindowOrigin.y + (y / scale)
    )
    return cgPointFromTop(ax: ax)
}

// Per-app input. Events go to one pid through SkyLight. The system pointer
// and the front window stay where the user left them.
enum Sky {
    private typealias PostToPidFn = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetAuthFn = @convention(c) (CGEvent, AnyObject) -> Void
    private typealias SetIntFn = @convention(c) (CGEvent, UInt32, Int64) -> Void
    private typealias SetWindowLocFn = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias FactoryFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Int32, UInt32) -> AnyObject?
    private typealias PostRecordFn = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32

    private static let sky: UnsafeMutableRawPointer? = dlopen(
        "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
        RTLD_LAZY
    )

    private static func sym<T>(_ name: String, as: T.Type) -> T? {
        _ = sky
        guard let p = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(p, to: T.self)
    }

    private static let postToPidFn: PostToPidFn? = sym("SLEventPostToPid", as: PostToPidFn.self)
    private static let setAuthFn: SetAuthFn? = sym("SLEventSetAuthenticationMessage", as: SetAuthFn.self)
    private static let setIntFn: SetIntFn? = sym("SLEventSetIntegerValueField", as: SetIntFn.self)
    private static let setWindowLocFn: SetWindowLocFn? = sym("CGEventSetWindowLocation", as: SetWindowLocFn.self)
    private static let msgSendFn: FactoryFn? = sym("objc_msgSend", as: FactoryFn.self)
    private static let postRecordFn: PostRecordFn? = sym("SLPSPostEventRecordTo", as: PostRecordFn.self)
    private static let authClass: AnyClass? = {
        _ = sky
        return NSClassFromString("SLSEventAuthenticationMessage")
    }()
    private static let authSel = NSSelectorFromString("messageWithEventRecord:pid:version:")

    private static func eventRecord(_ event: CGEvent) -> UnsafeMutableRawPointer? {
        let base = Unmanaged.passUnretained(event).toOpaque()
        for offset in [24, 32, 16] {
            let slot = base.advanced(by: offset).assumingMemoryBound(to: UnsafeMutableRawPointer?.self)
            if let p = slot.pointee { return p }
        }
        return nil
    }

    static func post(_ pid: pid_t, _ event: CGEvent, auth: Bool) -> Bool {
        guard let post = postToPidFn else { return false }
        if auth,
           let setAuth = setAuthFn,
           let send = msgSendFn,
           let cls = authClass,
           cls.responds(to: authSel),
           let record = eventRecord(event),
           let msg = send(cls as AnyObject, authSel, record, pid, 0) {
            setAuth(event, msg)
        }
        post(pid, event)
        return true
    }

    static func setWindowLocation(_ event: CGEvent, _ point: CGPoint) {
        setWindowLocFn?(event, point)
    }

    static func setField(_ event: CGEvent, _ field: UInt32, _ value: Int64) {
        setIntFn?(event, field, value)
    }

    // Make the window key without making the app frontmost.
    // yabai window_manager_make_key_window: type 0x01 then 0x02, same PSN.
    // The 0x0d record (byte 0x8a = 0x01) marks the process front and macOS
    // follows that app onto its Space. Do not post that record.
    static func focusWithoutRaise(pid: pid_t, windowID: CGWindowID) -> Bool {
        guard windowID != 0, pid > 0, let post = postRecordFn else { return false }
        var psn = [UInt32](repeating: 0, count: 2)
        let psnOk = psn.withUnsafeMutableBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            return GetProcessForPID(pid, base) == 0
        }
        guard psnOk else { return false }
        var buf = [UInt8](repeating: 0, count: 0xF8)
        buf[0x04] = 0xF8
        buf[0x3A] = 0x10
        for i in 0..<0x10 { buf[0x20 + i] = 0xFF }
        let wid = UInt32(windowID)
        buf[0x3C] = UInt8(wid & 0xFF)
        buf[0x3D] = UInt8((wid >> 8) & 0xFF)
        buf[0x3E] = UInt8((wid >> 16) & 0xFF)
        buf[0x3F] = UInt8((wid >> 24) & 0xFF)
        func send(_ kind: UInt8) {
            var bytes = buf
            bytes[0x08] = kind
            psn.withUnsafeBytes { raw in
                bytes.withUnsafeBufferPointer { bp in
                    guard let psnBase = raw.baseAddress, let ev = bp.baseAddress else { return }
                    _ = post(psnBase, ev)
                }
            }
        }
        send(0x01)
        send(0x02)
        return true
    }
}

@_silgen_name("GetProcessForPID")
func GetProcessForPID(_ pid: pid_t, _ psn: UnsafeMutableRawPointer) -> Int32

func screenToWindowLocal(_ point: CGPoint) -> CGPoint {
    let height = NSScreen.screens.map { $0.frame.maxY }.max() ?? point.y
    let pre = CGPoint(x: point.x, y: height - point.y)
    return CGPoint(x: pre.x - lastWindowOrigin.x, y: pre.y - lastWindowOrigin.y)
}

func deliverMouse(_ pid: pid_t, _ event: CGEvent) {
    event.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    // Same authenticated post as keys. An unauthenticated mouse event is
    // dropped unless the app is frontmost, and making it frontmost switches Spaces.
    if !Sky.post(pid, event, auth: true) {
        event.postToPid(pid)
    }
}

func deliverKey(_ pid: pid_t, _ event: CGEvent) {
    event.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    if !Sky.post(pid, event, auth: true) {
        event.postToPid(pid)
    }
}

func mouseEvent(type: NSEvent.EventType, clickCount: Int, windowID: CGWindowID) -> CGEvent? {
    NSEvent.mouseEvent(
        with: type,
        location: .zero,
        modifierFlags: [],
        timestamp: 0,
        windowNumber: Int(windowID),
        context: nil,
        eventNumber: 0,
        clickCount: clickCount,
        pressure: 1
    )?.cgEvent
}

func stampMouse(_ event: CGEvent, screen: CGPoint, local: CGPoint, windowID: CGWindowID, pid: pid_t, button: Int64, clickState: Int64) {
    event.location = screen
    event.setIntegerValueField(.mouseEventButtonNumber, value: button)
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    if windowID != 0 {
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    }
    Sky.setWindowLocation(event, local)
    Sky.setField(event, 40, Int64(pid))
}

func clickPoint(pid: pid_t, point: CGPoint, button: CGMouseButton, count: Int) {
    let wid = lastWindowID
    let local = screenToWindowLocal(point)
    if wid != 0 {
        _ = Sky.focusWithoutRaise(pid: pid, windowID: wid)
        usleep(50_000)
    }
    let pairs = max(1, min(3, count))
    let buttonNumber: Int64 = button == .right ? 1 : 0
    let downType: NSEvent.EventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: NSEvent.EventType = button == .right ? .rightMouseUp : .leftMouseUp
    if button == .left {
        guard let move = mouseEvent(type: .mouseMoved, clickCount: 0, windowID: wid),
              let primerDown = mouseEvent(type: .leftMouseDown, clickCount: 1, windowID: wid),
              let primerUp = mouseEvent(type: .leftMouseUp, clickCount: 1, windowID: wid) else { return }
        stampMouse(move, screen: point, local: local, windowID: wid, pid: pid, button: 0, clickState: 0)
        let off = CGPoint(x: -1, y: -1)
        stampMouse(primerDown, screen: off, local: off, windowID: wid, pid: pid, button: 0, clickState: 1)
        stampMouse(primerUp, screen: off, local: off, windowID: wid, pid: pid, button: 0, clickState: 1)
        deliverMouse(pid, move)
        usleep(15_000)
        deliverMouse(pid, primerDown)
        usleep(1_000)
        deliverMouse(pid, primerUp)
        usleep(100_000)
        for index in 1...pairs {
            guard let down = mouseEvent(type: downType, clickCount: index, windowID: wid),
                  let up = mouseEvent(type: upType, clickCount: index, windowID: wid) else { return }
            let state = Int64(index)
            stampMouse(down, screen: point, local: local, windowID: wid, pid: pid, button: 0, clickState: state)
            stampMouse(up, screen: point, local: local, windowID: wid, pid: pid, button: 0, clickState: state)
            deliverMouse(pid, down)
            usleep(1_000)
            deliverMouse(pid, up)
            if index < pairs { usleep(80_000) }
        }
        return
    }
    guard let move = mouseEvent(type: .mouseMoved, clickCount: 0, windowID: wid) else { return }
    stampMouse(move, screen: point, local: local, windowID: wid, pid: pid, button: buttonNumber, clickState: 0)
    deliverMouse(pid, move)
    usleep(15_000)
    for index in 1...pairs {
        guard let down = mouseEvent(type: downType, clickCount: index, windowID: wid),
              let up = mouseEvent(type: upType, clickCount: index, windowID: wid) else { return }
        let state = Int64(index)
        stampMouse(down, screen: point, local: local, windowID: wid, pid: pid, button: buttonNumber, clickState: state)
        stampMouse(up, screen: point, local: local, windowID: wid, pid: pid, button: buttonNumber, clickState: state)
        deliverMouse(pid, down)
        usleep(1_000)
        deliverMouse(pid, up)
        if index < pairs { usleep(80_000) }
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
    // AXFocused raises the window and macOS switches to that Space.
    _ = el
    _ = Sky.focusWithoutRaise(pid: lastPid, windowID: lastWindowID)
}

func typeUnicode(pid: pid_t, text: String) {
    if text.isEmpty { return }
    if lastPid == pid { _ = Sky.focusWithoutRaise(pid: pid, windowID: lastWindowID) }
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
    units.withUnsafeBufferPointer { ptr in
        guard let base = ptr.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
    }
    down.flags = []
    up.flags = []
    deliverKey(pid, down)
    deliverKey(pid, up)
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
    if lastPid == pid { _ = Sky.focusWithoutRaise(pid: pid, windowID: lastWindowID) }
    let parts = spec.split { $0 == "+" || $0 == "-" }.map { String($0).trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
    guard let last = parts.last, let code = keyCode(last == "meta" ? "command" : last) else { return }
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
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    deliverKey(pid, down)
    deliverKey(pid, up)
}

func jsonInt(_ value: Any?) -> Int? {
    if let n = value as? Int { return n }
    if let n = value as? NSNumber { return n.intValue }
    return nil
}

func jsonBool(_ value: Any?) -> Bool {
    if let n = value as? NSNumber { return n.boolValue }
    if let b = value as? Bool { return b }
    return false
}

var parkedFrontPid: pid_t = 0

func activateApp(_ pid: pid_t) {
    guard pid > 0,
          let app = NSRunningApplication(processIdentifier: pid),
          let url = app.bundleURL else { return }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = ["-a", url.path]
    try? task.run()
    task.waitUntilExit()
    usleep(400_000)
}

func bringForward(_ pid: pid_t) {
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    if parkedFrontPid == 0, front > 0, front != pid {
        parkedFrontPid = front
    }
    activateApp(pid)
}

func restorePayload() -> [String: Any] {
    let pid = parkedFrontPid
    parkedFrontPid = 0
    guard pid > 0, let app = NSRunningApplication(processIdentifier: pid) else {
        return ["ok": true, "restored": false]
    }
    activateApp(pid)
    return [
        "ok": true,
        "restored": true,
        "pid": Int(pid),
        "app": app.localizedName ?? "",
    ]
}

func postAtCursor(_ type: CGEventType, _ point: CGPoint, clickState: Int64) {
    CGWarpMouseCursorPosition(point)
    let button: CGMouseButton = (type == .rightMouseDown || type == .rightMouseUp) ? .right : .left
    guard let event = CGEvent(
        mouseEventSource: CGEventSource(stateID: .hidSystemState),
        mouseType: type,
        mouseCursorPosition: point,
        mouseButton: button
    ) else { return }
    if clickState > 0 {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    event.post(tap: .cghidEventTap)
}

func postRealClick(point: CGPoint, button: CGMouseButton, count: Int) {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    postAtCursor(.mouseMoved, point, clickState: 0)
    usleep(30_000)
    let pairs = max(1, min(3, count))
    for index in 1...pairs {
        let state = Int64(index)
        postAtCursor(down, point, clickState: state)
        usleep(12_000)
        postAtCursor(up, point, clickState: state)
        if index < pairs { usleep(80_000) }
    }
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
    if jsonBool(body["foreground"]) { bringForward(pid) }
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
        if jsonBool(body["foreground"]) {
            postRealClick(point: point, button: button, count: count)
        } else {
            clickPoint(pid: pid, point: point, button: button, count: count)
        }
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
    deliverMouse(pid, event)
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
    if jsonBool(body["foreground"]) {
        postAtCursor(.mouseMoved, start, clickState: 0)
        usleep(20_000)
        postAtCursor(.leftMouseDown, start, clickState: 1)
        for step in 1...5 {
            let t = CGFloat(step) / 5
            let mid = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
            postAtCursor(.leftMouseDragged, mid, clickState: 1)
            usleep(16_000)
        }
        postAtCursor(.leftMouseUp, end, clickState: 1)
        return ["ok": true]
    }
    let wid = lastWindowID
    if wid != 0 {
        _ = Sky.focusWithoutRaise(pid: pid, windowID: wid)
        usleep(50_000)
    }
    func postDrag(_ type: NSEvent.EventType, _ screen: CGPoint) {
        guard let event = mouseEvent(type: type, clickCount: type == .leftMouseDown || type == .leftMouseUp ? 1 : 0, windowID: wid) else { return }
        stampMouse(event, screen: screen, local: screenToWindowLocal(screen), windowID: wid, pid: pid, button: 0, clickState: type == .mouseMoved ? 0 : 1)
        deliverMouse(pid, event)
    }
    postDrag(.mouseMoved, start)
    usleep(15_000)
    postDrag(.leftMouseDown, start)
    for step in 1...5 {
        let t = CGFloat(step) / 5
        let mid = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        postDrag(.leftMouseDragged, mid)
        usleep(16_000)
    }
    postDrag(.leftMouseUp, end)
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
    return performOnElement(body) { el, pid, _ in
        let token = axActionToken(name)
        if name.lowercased() == "raise" || token == "AXRaise" {
            bringForward(pid)
            return ["ok": true]
        }
        _ = Sky.focusWithoutRaise(pid: pid, windowID: lastWindowID)
        usleep(30_000)
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
    if cmd != "restore", cmd != "state", jsonBool(body["foreground"]) {
        let pid = pid_t(jsonInt(body["pid"]) ?? Int(lastPid))
        if pid > 0 { bringForward(pid) }
    }
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
    case "restore": reply = restorePayload()
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
