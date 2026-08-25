import CoreLocation
import Foundation
import SwiftUI
import UIKit

/// Last GPS fix from Yan's iPhone. Posted to the Mac API so the web Personal Agent
/// can see it too. Only runs for Yan's account, and only on iPhone. iPad chat maps
/// use MapKit GPS on-device and never post to this ingest.
///
/// Always: significant-change (~500m) + visits + a 15-minute heartbeat (`periodic`).
/// Heartbeats do not start agents; they only write the live fix and JSONL history.
/// Force-quit stops the 15-minute timer. Significant-change and visits stay
/// registered with iOS and can relaunch this process; `restoreFromAppGroup()`
/// restarts monitoring so those posts still land.
final class PhoneLocationReporter: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    static let shared = PhoneLocationReporter()

    private static let heartbeatInterval: TimeInterval = 15 * 60
    private static let foregroundMinInterval: TimeInterval = 25
    private static let movementMeters: CLLocationDistance = 500

    private lazy var manager: CLLocationManager = {
        let m = CLLocationManager()
        m.delegate = self
        m.desiredAccuracy = kCLLocationAccuracyHundredMeters
        m.distanceFilter = 150
        m.pausesLocationUpdatesAutomatically = false
        m.showsBackgroundLocationIndicator = false
        return m
    }()
    private let geocoder = CLGeocoder()
    private let lock = NSLock()
    private var token: String?
    private var enabled = false
    private var sceneActive = true
    private var nextFixIsPeriodic = false
    private var heartbeatTimer: Timer?
    private var askedAlways: Bool {
        get { UserDefaults.standard.bool(forKey: "yl.askedAlwaysLocation") }
        set { UserDefaults.standard.set(newValue, forKey: "yl.askedAlwaysLocation") }
    }
    private var lastFix: AgentPhoneLocation?
    private var lastPostAt: Date?
    private var lastPostedCoordinate: CLLocationCoordinate2D?
    private var posting = false
    private static let iso8601 = ISO8601DateFormatter()
    private static let iso8601Lock = NSLock()

    private static let yanEmails: Set<String> = [
        "you@example.com",
        "you@icloud.com",
    ]

    private override init() {
        super.init()
    }

    var snapshot: AgentPhoneLocation? {
        lock.lock()
        defer { lock.unlock() }
        return lastFix
    }

    private func setLastFix(_ fix: AgentPhoneLocation) {
        lock.lock()
        lastFix = fix
        lock.unlock()
    }

    /// Call from app `init` so a background relaunch (force-quit + ~500m / visit)
    /// restarts monitoring before SwiftUI finishes coming up.
    func restoreFromAppGroup() {
        guard AppGroupStore.hasFullAccess, let token = AppGroupStore.token else { return }
        sceneActive = UIApplication.shared.applicationState == .active
        attach(email: AppGroupStore.email, token: token, fullAccess: true)
    }

    func attach(email: String?, token: String?, fullAccess: Bool) {
        guard AdaptiveLayout.isPhone else {
            self.token = nil
            enabled = false
            return
        }
        let allowed =
            fullAccess
            && Self.yanEmails.contains((email ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        self.token = allowed ? token : nil
        let next = allowed && !(token ?? "").isEmpty
        if next {
            enabled = true
            startIfPossible()
        } else {
            if enabled {
                stopBackgroundTracking()
            }
            enabled = false
        }
    }

    func handleScenePhase(_ phase: ScenePhase) {
        sceneActive = phase == .active
        guard enabled else { return }
        if phase == .active {
            refresh()
        }
    }

    func refresh() {
        guard enabled else { return }
        startIfPossible()
        manager.requestLocation()
    }

    private func startIfPossible() {
        guard enabled else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            stopHeartbeatTimer()
            manager.allowsBackgroundLocationUpdates = false
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            manager.stopMonitoringVisits()
            if !askedAlways {
                askedAlways = true
                manager.requestAlwaysAuthorization()
            }
            manager.requestLocation()
        case .authorizedAlways:
            manager.allowsBackgroundLocationUpdates = true
            manager.pausesLocationUpdatesAutomatically = false
            manager.startMonitoringSignificantLocationChanges()
            manager.startMonitoringVisits()
            manager.startUpdatingLocation()
            startHeartbeatTimer()
            manager.requestLocation()
        default:
            stopBackgroundTracking()
        }
    }

    private func stopBackgroundTracking() {
        stopHeartbeatTimer()
        manager.allowsBackgroundLocationUpdates = false
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.stopMonitoringVisits()
    }

    private func startHeartbeatTimer() {
        let start = { [weak self] in
            guard let self, self.heartbeatTimer == nil, self.enabled else { return }
            let timer = Timer(timeInterval: Self.heartbeatInterval, repeats: true) { [weak self] _ in
                self?.heartbeatTick()
            }
            timer.tolerance = 30
            RunLoop.main.add(timer, forMode: .common)
            self.heartbeatTimer = timer
        }
        if Thread.isMainThread {
            start()
        } else {
            DispatchQueue.main.async(execute: start)
        }
    }

    private func stopHeartbeatTimer() {
        let stop = { [weak self] in
            self?.heartbeatTimer?.invalidate()
            self?.heartbeatTimer = nil
            self?.nextFixIsPeriodic = false
        }
        if Thread.isMainThread {
            stop()
        } else {
            DispatchQueue.main.async(execute: stop)
        }
    }

    private func heartbeatTick() {
        guard enabled else { return }
        nextFixIsPeriodic = true
        manager.requestLocation()
        Task { await self.postPeriodicHeartbeat() }
    }

    /// `requestLocation()` is a no-op while `startUpdatingLocation()` is running, so
    /// re-post the last fix every 15 minutes while sitting still.
    private func postPeriodicHeartbeat() async {
        guard enabled, let token, !token.isEmpty else { return }
        guard var fix = snapshot else { return }
        fix.source = "periodic"
        fix.visitKind = nil
        fix.timestamp = Self.iso8601String(from: Date())
        await post(fix, token: token)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async { self.startIfPossible() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("PhoneLocationReporter: %@", error.localizedDescription)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        Task { await self.handle(location: loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        Task { await self.handle(visit: visit) }
    }

    private func handle(visit: CLVisit) async {
        let departing = visit.departureDate != .distantFuture
        let when = departing ? visit.departureDate : visit.arrivalDate
        guard when != .distantPast, when != .distantFuture else { return }
        let loc = CLLocation(latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude)
        await handle(
            location: loc,
            visitKind: departing ? "departure" : "arrival",
            at: when,
            source: "visit"
        )
    }

    private func handle(
        location: CLLocation,
        visitKind: String? = nil,
        at: Date? = nil,
        source: String = "ios"
    ) async {
        guard enabled, let token, !token.isEmpty else { return }
        let tagged: String
        if visitKind != nil {
            tagged = "visit"
        } else if nextFixIsPeriodic {
            nextFixIsPeriodic = false
            tagged = "periodic"
        } else {
            tagged = source
        }
        var fix = AgentPhoneLocation(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy > 0 ? location.horizontalAccuracy : nil,
            timestamp: Self.iso8601String(from: at ?? location.timestamp),
            source: tagged,
            speedMps: location.speed >= 0 ? location.speed : nil,
            courseDegrees: location.course >= 0 ? location.course : nil,
            altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
            visitKind: visitKind
        )
        if let marks = try? await geocoder.reverseGeocodeLocation(location), let mark = marks.first {
            fix.placeName = Self.clip(mark.name)
            fix.locality = Self.clip(mark.locality)
            fix.subLocality = Self.clip(mark.subLocality)
            fix.administrativeArea = Self.clip(mark.administrativeArea)
            fix.postalCode = Self.clip(mark.postalCode)
            fix.country = Self.clip(mark.country)
            let areas = (mark.areasOfInterest ?? []).map(Self.clip).filter { !$0.isEmpty }
            if !areas.isEmpty { fix.areasOfInterest = Array(areas.prefix(6)) }
        }
        setLastFix(fix)
        await post(fix, token: token)
    }

    private func post(_ fix: AgentPhoneLocation, token: String) async {
        if posting { return }
        guard shouldPost(fix) else { return }
        posting = true
        defer { posting = false }
        do {
            _ = try await APIClient.shared.requestRaw(
                "api/education/location",
                method: "POST",
                body: fix,
                bearer: token
            )
            lastPostAt = Date()
            lastPostedCoordinate = CLLocationCoordinate2D(latitude: fix.latitude, longitude: fix.longitude)
        } catch {
            NSLog("PhoneLocationReporter post: %@", error.localizedDescription)
        }
    }

    private func shouldPost(_ fix: AgentPhoneLocation) -> Bool {
        if fix.visitKind != nil { return true }
        if sceneActive {
            if let lastPostAt, Date().timeIntervalSince(lastPostAt) < Self.foregroundMinInterval {
                return false
            }
            return true
        }
        if lastPostAt == nil { return true }
        if let lastPostAt, Date().timeIntervalSince(lastPostAt) >= Self.heartbeatInterval {
            return true
        }
        if let lastPostedCoordinate {
            let from = CLLocation(latitude: lastPostedCoordinate.latitude, longitude: lastPostedCoordinate.longitude)
            let to = CLLocation(latitude: fix.latitude, longitude: fix.longitude)
            if from.distance(from: to) >= Self.movementMeters { return true }
        }
        return false
    }

    private static func iso8601String(from date: Date) -> String {
        iso8601Lock.lock()
        defer { iso8601Lock.unlock() }
        return iso8601.string(from: date)
    }

    private static func clip(_ raw: String?) -> String {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }
        return String(s.prefix(120))
    }
}

struct AgentPhoneLocation: Codable, Equatable {
    var latitude: Double
    var longitude: Double
    var accuracyMeters: Double?
    var timestamp: String?
    var source: String?
    var speedMps: Double?
    var courseDegrees: Double?
    var altitudeMeters: Double?
    var visitKind: String?
    var placeName: String?
    var locality: String?
    var subLocality: String?
    var administrativeArea: String?
    var postalCode: String?
    var country: String?
    var areasOfInterest: [String]?
}
