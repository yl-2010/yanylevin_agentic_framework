import Foundation
import HomeKit

enum HomeCLI {
    static var finished = false
    private static var outURL: URL?
    private static var runner: HomeRunner?

    static func run() {
        let parsed = ParsedArgs.parse(Array(CommandLine.arguments.dropFirst()))
        outURL = parsed.outURL
        if parsed.command == "help" || parsed.command == "--help" {
            succeed([
                "ok": true,
                "usage": "yl-home homes | rooms | list [--room NAME] [--type TYPE] [--live] | get NAME | set NAME KEY VALUE | toggle NAME | scenes | trigger SCENE",
            ])
            return
        }
        let runner = HomeRunner(args: parsed)
        self.runner = runner
        runner.start()
    }

    static func succeed(_ obj: [String: Any]) {
        emit(obj, code: 0)
    }

    static func fail(_ msg: String, extra: [String: Any] = [:]) {
        var obj: [String: Any] = ["ok": false, "error": msg]
        for (k, v) in extra { obj[k] = v }
        emit(obj, code: 1)
    }

    private static func emit(_ obj: [String: Any], code: Int32) {
        guard !finished else { return }
        finished = true
        let data = jsonData(obj)
        if let data {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
        }
        if let outURL, let data {
            try? data.write(to: outURL, options: .atomic)
        }
        exit(code)
    }
}

struct ParsedArgs {
    var command: String
    var rest: [String]
    var home: String?
    var room: String?
    var type: String?
    var live: Bool
    var outURL: URL?

    static func parse(_ args: [String]) -> ParsedArgs {
        var home: String?
        var room: String?
        var type: String?
        var live = false
        var outURL: URL?
        var positional: [String] = []
        var i = 0
        while i < args.count {
            let a = args[i]
            func take() -> String? {
                guard i + 1 < args.count else { return nil }
                i += 1
                return args[i]
            }
            switch a {
            case "--home": home = take()
            case "--room": room = take()
            case "--type": type = take()
            case "--live": live = true
            case "--out":
                if let p = take() { outURL = URL(fileURLWithPath: p) }
            default:
                positional.append(a)
            }
            i += 1
        }
        return ParsedArgs(
            command: positional.first ?? "help",
            rest: Array(positional.dropFirst()),
            home: home,
            room: room,
            type: type,
            live: live,
            outURL: outURL
        )
    }
}

final class HomeRunner: NSObject, HMHomeManagerDelegate {
    private let args: ParsedArgs
    private var manager: HMHomeManager?
    private var dispatched = false

    init(args: ParsedArgs) {
        self.args = args
        super.init()
    }

    func start() {
        let manager = HMHomeManager()
        self.manager = manager
        manager.delegate = self
    }

    func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        considerReady(manager)
    }

    func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        considerReady(manager)
    }

    private func considerReady(_ manager: HMHomeManager) {
        if manager.authorizationStatus.contains(.restricted) {
            HomeCLI.fail("HomeKit access denied. Grant HomeKit to yl-home in System Settings > Privacy & Security.")
            return
        }
        if !manager.authorizationStatus.contains(.authorized) {
            return
        }
        dispatch(manager.homes)
    }

    private func dispatch(_ homes: [HMHome]) {
        guard !dispatched else { return }
        dispatched = true
        let filtered = filterHomes(homes)
        switch args.command {
        case "homes":
            HomeCLI.succeed([
                "ok": true,
                "homes": homes.map { [
                    "id": $0.uniqueIdentifier.uuidString,
                    "name": $0.name,
                ] as [String: Any] },
            ])
        case "rooms":
            HomeCLI.succeed(["ok": true, "rooms": roomsJSON(filtered)])
        case "list":
            list(filtered)
        case "get":
            guard let name = args.rest.first, !name.isEmpty else {
                HomeCLI.fail("get requires an accessory name or id")
                return
            }
            get(filtered, name: name)
        case "set":
            set(filtered)
        case "toggle":
            guard let name = args.rest.first, !name.isEmpty else {
                HomeCLI.fail("toggle requires an accessory name or id")
                return
            }
            toggle(filtered, name: name)
        case "scenes":
            HomeCLI.succeed(["ok": true, "scenes": scenesJSON(filtered)])
        case "trigger":
            guard let name = args.rest.first, !name.isEmpty else {
                HomeCLI.fail("trigger requires a scene name")
                return
            }
            trigger(filtered, name: name)
        default:
            HomeCLI.fail("unknown command \(args.command)")
        }
    }

    private func filterHomes(_ homes: [HMHome]) -> [HMHome] {
        guard let want = args.home?.lowercased(), !want.isEmpty else { return homes }
        let hit = homes.filter { $0.name.lowercased() == want || $0.uniqueIdentifier.uuidString.lowercased() == want }
        return hit.isEmpty ? homes.filter { $0.name.lowercased().contains(want) } : hit
    }

    private func roomsJSON(_ homes: [HMHome]) -> [[String: Any]] {
        homes.flatMap { home in
            home.rooms.map { room -> [String: Any] in
                [
                    "home": home.name,
                    "name": room.name,
                    "id": room.uniqueIdentifier.uuidString,
                    "accessories": room.accessories.map(\.name),
                ]
            }
        }
    }

    private func scenesJSON(_ homes: [HMHome]) -> [[String: Any]] {
        homes.flatMap { home in
            home.actionSets.map { set -> [String: Any] in
                [
                    "home": home.name,
                    "name": set.name,
                    "id": set.uniqueIdentifier.uuidString,
                ]
            }
        }
    }

    private func list(_ homes: [HMHome]) {
        let wanted = matchingAccessories(homes)
        if !args.live {
            HomeCLI.succeed(["ok": true, "accessories": wanted.map { snapshot($0, live: false) }])
            return
        }
        let group = DispatchGroup()
        var rows: [[String: Any]] = []
        let lock = NSLock()
        for item in wanted {
            group.enter()
            readAll(item.accessory) {
                lock.lock()
                rows.append(self.snapshot(item, live: true))
                lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .main) {
            HomeCLI.succeed(["ok": true, "accessories": rows])
        }
    }

    private func get(_ homes: [HMHome], name: String) {
        switch resolve(homes, name: name) {
        case .fail(let msg, let extra):
            HomeCLI.fail(msg, extra: extra)
        case .ok(let item):
            readAll(item.accessory) {
                HomeCLI.succeed(["ok": true, "accessory": self.snapshot(item, live: true)])
            }
        }
    }

    private func toggle(_ homes: [HMHome], name: String) {
        switch resolve(homes, name: name) {
        case .fail(let msg, let extra):
            HomeCLI.fail(msg, extra: extra)
        case .ok(let item):
            guard let char = findChar(item.accessory, keys: ["on"]) else {
                HomeCLI.fail("\(item.accessory.name) has no on/off characteristic")
                return
            }
            char.readValue { error in
                if let error {
                    HomeCLI.fail(error.localizedDescription)
                    return
                }
                let next = !(boolValue(char.value) ?? false)
                self.write(item, pairs: [("on", next ? "true" : "false")])
            }
        }
    }

    private func set(_ homes: [HMHome]) {
        guard let name = args.rest.first, !name.isEmpty else {
            HomeCLI.fail("set requires an accessory name or id")
            return
        }
        let pairs = parsePairs(Array(args.rest.dropFirst()))
        if pairs.isEmpty {
            HomeCLI.fail("set requires on/off or KEY VALUE pairs (brightness 40, hue 30)")
            return
        }
        switch resolve(homes, name: name) {
        case .fail(let msg, let extra):
            HomeCLI.fail(msg, extra: extra)
        case .ok(let item):
            write(item, pairs: pairs)
        }
    }

    private func trigger(_ homes: [HMHome], name: String) {
        let want = name.lowercased()
        let hits = homes.flatMap { home in
            home.actionSets.filter { $0.name.lowercased() == want || $0.uniqueIdentifier.uuidString.lowercased() == want }
                .map { (home, $0) }
        }
        let fuzzy = hits.isEmpty
            ? homes.flatMap { home in
                home.actionSets.filter { $0.name.lowercased().contains(want) }.map { (home, $0) }
            }
            : hits
        guard fuzzy.count == 1, let (home, scene) = fuzzy.first else {
            if fuzzy.isEmpty {
                HomeCLI.fail("scene not found: \(name)")
            } else {
                HomeCLI.fail("scene name is ambiguous", extra: ["matches": fuzzy.map { "\($0.0.name)/\($0.1.name)" }])
            }
            return
        }
        home.executeActionSet(scene) { error in
            if let error {
                HomeCLI.fail(error.localizedDescription)
                return
            }
            HomeCLI.succeed(["ok": true, "triggered": scene.name, "home": home.name])
        }
    }

    private func write(_ item: AccessoryRef, pairs: [(String, String)]) {
        var pending = pairs
        func next() {
            guard let (key, raw) = pending.first else {
                self.readAll(item.accessory) {
                    HomeCLI.succeed(["ok": true, "accessory": self.snapshot(item, live: true)])
                }
                return
            }
            pending.removeFirst()
            guard let char = findChar(item.accessory, keys: [key]) else {
                HomeCLI.fail("\(item.accessory.name) has no writable '\(key)'")
                return
            }
            do {
                let value = try coerce(key: canonicalKey(char.characteristicType) ?? key, raw: raw)
                char.writeValue(value) { error in
                    if let error {
                        HomeCLI.fail(error.localizedDescription)
                        return
                    }
                    next()
                }
            } catch {
                HomeCLI.fail(error.localizedDescription)
            }
        }
        next()
    }

    private func matchingAccessories(_ homes: [HMHome]) -> [AccessoryRef] {
        var out: [AccessoryRef] = []
        for home in homes {
            for acc in home.accessories {
                let room = acc.room?.name ?? "Default Room"
                if let want = args.room?.lowercased(), !want.isEmpty {
                    if room.lowercased() != want && !room.lowercased().contains(want) { continue }
                }
                let kind = accessoryKind(acc)
                if let want = args.type?.lowercased(), !want.isEmpty {
                    if kind != want && !kind.contains(want) { continue }
                }
                out.append(AccessoryRef(home: home, accessory: acc, room: room, kind: kind))
            }
        }
        return out.sorted { a, b in
            if a.room != b.room { return a.room < b.room }
            return a.accessory.name < b.accessory.name
        }
    }

    private enum Resolve {
        case ok(AccessoryRef)
        case fail(String, [String: Any])
    }

    private func resolve(_ homes: [HMHome], name: String) -> Resolve {
        let want = name.lowercased()
        let all = matchingAccessories(homes)
        let exact = all.filter {
            $0.accessory.name.lowercased() == want
                || $0.accessory.uniqueIdentifier.uuidString.lowercased() == want
                || "\($0.room.lowercased())/\($0.accessory.name.lowercased())" == want
        }
        let hits = exact.isEmpty
            ? all.filter {
                $0.accessory.name.lowercased().contains(want)
                    || "\($0.room) \($0.accessory.name)".lowercased().contains(want)
            }
            : exact
        if hits.isEmpty {
            return .fail("accessory not found: \(name)", [:])
        }
        if hits.count > 1 {
            return .fail("accessory name is ambiguous", [
                "matches": hits.map { "\($0.room)/\($0.accessory.name)" },
            ])
        }
        return .ok(hits[0])
    }

    private func snapshot(_ item: AccessoryRef, live: Bool) -> [String: Any] {
        var chars: [String: Any] = [:]
        for service in item.accessory.services where service.serviceType != HMServiceTypeAccessoryInformation {
            for char in service.characteristics where !char.properties.contains(HMCharacteristicPropertyHidden) {
                guard let key = canonicalKey(char.characteristicType) else { continue }
                if let labeled = labeledValue(char) {
                    chars[key] = labeled
                } else if let v = jsonSafe(char.value) {
                    chars[key] = v
                }
            }
        }
        var out: [String: Any] = [
            "id": item.accessory.uniqueIdentifier.uuidString,
            "name": item.accessory.name,
            "home": item.home.name,
            "room": item.room,
            "type": item.kind,
            "reachable": item.accessory.isReachable,
            "live": live,
            "characteristics": chars,
        ]
        if let on = chars["on"] { out["on"] = on }
        if let brightness = chars["brightness"] { out["brightness"] = brightness }
        return out
    }

    private func readAll(_ accessory: HMAccessory, done: @escaping () -> Void) {
        let chars = accessory.services.flatMap(\.characteristics).filter {
            $0.properties.contains(HMCharacteristicPropertyReadable)
                && !$0.properties.contains(HMCharacteristicPropertyHidden)
        }
        let group = DispatchGroup()
        for char in chars {
            group.enter()
            char.readValue { _ in group.leave() }
        }
        group.notify(queue: .main, execute: done)
    }

    private func findChar(_ accessory: HMAccessory, keys: [String]) -> HMCharacteristic? {
        let want = Set(keys.map { $0.lowercased() }.flatMap { aliases[$0] ?? [$0] })
        for service in accessory.services {
            for char in service.characteristics {
                guard char.properties.contains(HMCharacteristicPropertyWritable) else { continue }
                let key = canonicalKey(char.characteristicType) ?? ""
                if want.contains(key) { return char }
            }
        }
        return nil
    }
}

struct AccessoryRef {
    let home: HMHome
    let accessory: HMAccessory
    let room: String
    let kind: String
}

private let aliases: [String: [String]] = [
    "on": ["on", "power", "power_state"],
    "off": ["on"],
    "power": ["on"],
    "power_state": ["on"],
    "brightness": ["brightness"],
    "hue": ["hue"],
    "saturation": ["saturation"],
    "color_temperature": ["color_temperature", "color-temperature", "colortemp"],
    "color-temperature": ["color_temperature"],
    "colortemp": ["color_temperature"],
    "target_temperature": ["target_temperature", "temperature", "temp"],
    "temperature": ["target_temperature"],
    "temp": ["target_temperature"],
    "heating_cooling": ["heating_cooling", "mode", "hvac"],
    "mode": ["heating_cooling"],
    "hvac": ["heating_cooling"],
    "lock": ["lock", "lock_target"],
    "lock_target": ["lock"],
    "door": ["door", "target_door"],
    "target_door": ["door"],
    "position": ["position", "target_position"],
    "target_position": ["position"],
    "speed": ["speed", "rotation_speed"],
    "rotation_speed": ["speed"],
]

private func canonicalKey(_ type: String) -> String? {
    switch type {
    case HMCharacteristicTypePowerState: return "on"
    case HMCharacteristicTypeBrightness: return "brightness"
    case HMCharacteristicTypeHue: return "hue"
    case HMCharacteristicTypeSaturation: return "saturation"
    case HMCharacteristicTypeColorTemperature: return "color_temperature"
    case HMCharacteristicTypeCurrentTemperature: return "current_temperature"
    case HMCharacteristicTypeTargetTemperature: return "target_temperature"
    case HMCharacteristicTypeCurrentHeatingCooling: return "current_heating_cooling"
    case HMCharacteristicTypeTargetHeatingCooling: return "heating_cooling"
    case HMCharacteristicTypeCurrentRelativeHumidity: return "humidity"
    case HMCharacteristicTypeTargetRelativeHumidity: return "target_humidity"
    case HMCharacteristicTypeRotationSpeed: return "speed"
    case HMCharacteristicTypeRotationDirection: return "rotation_direction"
    case HMCharacteristicTypeSwingMode: return "swing"
    case HMCharacteristicTypeCurrentLockMechanismState: return "lock"
    case HMCharacteristicTypeTargetLockMechanismState: return "lock_target"
    case HMCharacteristicTypeCurrentDoorState: return "door"
    case HMCharacteristicTypeTargetDoorState: return "target_door"
    case HMCharacteristicTypeCurrentPosition: return "current_position"
    case HMCharacteristicTypeTargetPosition: return "position"
    case HMCharacteristicTypePositionState: return "position_state"
    case HMCharacteristicTypeMotionDetected: return "motion"
    case HMCharacteristicTypeOccupancyDetected: return "occupancy"
    case HMCharacteristicTypeContactState: return "contact"
    case HMCharacteristicTypeLeakDetected: return "leak"
    case HMCharacteristicTypeSmokeDetected: return "smoke"
    case HMCharacteristicTypeCarbonMonoxideDetected: return "carbon_monoxide"
    case HMCharacteristicTypeCarbonDioxideDetected: return "carbon_dioxide"
    case HMCharacteristicTypeCurrentLightLevel: return "light_level"
    case HMCharacteristicTypeBatteryLevel: return "battery"
    case HMCharacteristicTypeStatusLowBattery: return "low_battery"
    case HMCharacteristicTypeChargingState: return "charging"
    case HMCharacteristicTypeOutletInUse: return "in_use"
    case HMCharacteristicTypeStatusActive: return "active"
    case HMCharacteristicTypeStatusFault: return "fault"
    case HMCharacteristicTypeStatusTampered: return "tampered"
    case HMCharacteristicTypeObstructionDetected: return "obstruction"
    default: return nil
    }
}

private func accessoryKind(_ acc: HMAccessory) -> String {
    let types = Set(acc.services.map(\.serviceType))
    if types.contains(HMServiceTypeLightbulb) { return "light" }
    if types.contains(HMServiceTypeThermostat) { return "thermostat" }
    if types.contains(HMServiceTypeLockMechanism) { return "lock" }
    if types.contains(HMServiceTypeGarageDoorOpener) { return "garage" }
    if types.contains(HMServiceTypeWindowCovering) || types.contains(HMServiceTypeWindow) { return "covering" }
    if types.contains(HMServiceTypeFan) { return "fan" }
    if types.contains(HMServiceTypeOutlet) { return "outlet" }
    if types.contains(HMServiceTypeSwitch) { return "switch" }
    if types.contains(HMServiceTypeMotionSensor) { return "motion_sensor" }
    if types.contains(HMServiceTypeOccupancySensor) { return "occupancy_sensor" }
    if types.contains(HMServiceTypeContactSensor) { return "contact_sensor" }
    if types.contains(HMServiceTypeTemperatureSensor) { return "temperature_sensor" }
    if types.contains(HMServiceTypeHumiditySensor) { return "humidity_sensor" }
    if types.contains(HMServiceTypeLeakSensor) { return "leak_sensor" }
    if types.contains(HMServiceTypeSmokeSensor) { return "smoke_sensor" }
    if types.contains(HMServiceTypeCarbonMonoxideSensor) { return "co_sensor" }
    if types.contains(HMServiceTypeCarbonDioxideSensor) { return "co2_sensor" }
    if types.contains(HMServiceTypeLightSensor) { return "light_sensor" }
    return "other"
}

private func parsePairs(_ rest: [String]) -> [(String, String)] {
    if rest.count == 1 {
        let token = rest[0].lowercased()
        if token == "on" { return [("on", "true")] }
        if token == "off" { return [("on", "false")] }
        if token == "lock" || token == "locked" { return [("lock", "locked")] }
        if token == "unlock" || token == "unlocked" { return [("lock", "unlocked")] }
        if token == "open" { return [("door", "open")] }
        if token == "close" || token == "closed" { return [("door", "closed")] }
    }
    var pairs: [(String, String)] = []
    var i = 0
    while i < rest.count {
        var key = rest[i]
        if key.hasPrefix("--") { key = String(key.dropFirst(2)) }
        if i + 1 < rest.count {
            pairs.append((key, rest[i + 1]))
            i += 2
        } else {
            if key.lowercased() == "on" { pairs.append(("on", "true")) }
            else if key.lowercased() == "off" { pairs.append(("on", "false")) }
            i += 1
        }
    }
    return pairs
}

private func coerce(key: String, raw: String) throws -> Any {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = s.lowercased()
    switch key {
    case "on":
        if ["1", "true", "on", "yes"].contains(lower) { return true }
        if ["0", "false", "off", "no"].contains(lower) { return false }
        throw simpleError("on must be true/false/on/off")
    case "brightness", "position", "current_position", "speed", "battery":
        guard let n = parseNumber(s) else { throw simpleError("\(key) must be a number") }
        return Int(n.rounded())
    case "hue", "saturation", "humidity", "target_humidity", "light_level":
        guard let n = parseNumber(s) else { throw simpleError("\(key) must be a number") }
        return n
    case "color_temperature":
        guard let n = parseNumber(s) else { throw simpleError("color_temperature must be a number (mireds)") }
        return Int(n.rounded())
    case "target_temperature":
        guard let n = parseNumber(s) else { throw simpleError("temperature must be a number") }
        let celsius = n >= 40 ? (n - 32) * 5 / 9 : n
        return celsius
    case "heating_cooling":
        switch lower {
        case "off", "0": return 0
        case "heat", "1": return 1
        case "cool", "2": return 2
        case "auto", "3": return 3
        default: throw simpleError("heating_cooling must be off/heat/cool/auto")
        }
    case "lock", "lock_target":
        if ["lock", "locked", "secure", "secured", "1"].contains(lower) { return 1 }
        if ["unlock", "unlocked", "unsecure", "unsecured", "0"].contains(lower) { return 0 }
        throw simpleError("lock must be locked or unlocked")
    case "door", "target_door":
        if ["open", "opened", "0"].contains(lower) { return 0 }
        if ["close", "closed", "1"].contains(lower) { return 1 }
        throw simpleError("door must be open or closed")
    default:
        if let b = boolValue(s) { return b }
        if let n = parseNumber(s) { return n }
        return s
    }
}

private func labeledValue(_ char: HMCharacteristic) -> Any? {
    let key = canonicalKey(char.characteristicType)
    switch key {
    case "lock", "lock_target":
        switch intValue(char.value) {
        case 0: return "unlocked"
        case 1: return "locked"
        case 2: return "jammed"
        case 3: return "unknown"
        default: return jsonSafe(char.value)
        }
    case "door", "target_door":
        switch intValue(char.value) {
        case 0: return "open"
        case 1: return "closed"
        case 2: return "opening"
        case 3: return "closing"
        case 4: return "stopped"
        default: return jsonSafe(char.value)
        }
    case "heating_cooling", "current_heating_cooling":
        switch intValue(char.value) {
        case 0: return "off"
        case 1: return "heat"
        case 2: return "cool"
        case 3: return "auto"
        default: return jsonSafe(char.value)
        }
    case "contact":
        switch intValue(char.value) {
        case 0: return "detected"
        case 1: return "not_detected"
        default: return jsonSafe(char.value)
        }
    case "current_temperature", "target_temperature":
        guard let c = doubleValue(char.value) else { return jsonSafe(char.value) }
        let f = c * 9 / 5 + 32
        return [
            "c": (c * 10).rounded() / 10,
            "f": (f * 10).rounded() / 10,
        ]
    default:
        return nil
    }
}

private func parseNumber(_ s: String) -> Double? {
    let trimmed = s.replacingOccurrences(of: "%", with: "")
    return Double(trimmed)
}

private func boolValue(_ value: Any?) -> Bool? {
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    if let s = value as? String {
        let lower = s.lowercased()
        if ["1", "true", "on", "yes"].contains(lower) { return true }
        if ["0", "false", "off", "no"].contains(lower) { return false }
    }
    return nil
}

private func intValue(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return n.intValue }
    return nil
}

private func doubleValue(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let n = value as? NSNumber { return n.doubleValue }
    return nil
}

private func jsonSafe(_ value: Any?) -> Any? {
    guard let value else { return nil }
    if value is NSNull { return nil }
    if value is String || value is Bool { return value }
    if let n = value as? NSNumber { return n }
    if let n = value as? Int { return n }
    if let n = value as? Double { return n }
    if let n = value as? Float { return n }
    return "\(value)"
}

private func jsonData(_ obj: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject(obj) else { return nil }
    return try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
}

private func simpleError(_ msg: String) -> NSError {
    NSError(domain: "yl-home", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
}
