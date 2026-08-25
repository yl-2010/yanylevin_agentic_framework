import CoreLocation
import MapKit
import SwiftUI
import UIKit
import WebKit

/// Outer glass 22 + 8pt inset → inner 14 so map/html/image sit concentrically.
/// HTML cards use a shorter bottom inset so the Liquid Glass rim does not
/// read as a thicker chin under the webview.
private enum ChatWidgetChrome {
    static let glassRadius: CGFloat = 22
    static let contentPad: CGFloat = 8
    static let innerRadius: CGFloat = 14
    static let htmlBottomPad: CGFloat = 3
}

struct ChatWidgetCarousel: View {
    let widgets: [ChatWidget]
    var queued: Bool = false
    /// Matches the chat list’s horizontal inset so the first card lines up
    /// with the bubble and the last card keeps the same gap on the right.
    var leadingInset: CGFloat = 16

    @State private var focusedId: String?
    @State private var expandedMap = false
    @State private var htmlHeights: [String: CGFloat] = [:]
    @Environment(\.colorScheme) private var colorScheme

    /// Room for Liquid Glass shadows and finger-warp so they are not clipped.
    private static let bloomPad: CGFloat = 22
    private static let nextCardPeek: CGFloat = 48

    private var mapPins: [ChatMapPin] {
        widgets.first(where: { $0.type == "map" })?.pins ?? []
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(widgets) { widget in
                    card(widget)
                        .containerRelativeFrame(.horizontal) { width, _ in
                            cardWidth(in: width)
                        }
                        .frame(minHeight: widget.type == "html" ? 0 : 180)
                        .contentShape(RoundedRectangle(cornerRadius: ChatWidgetChrome.glassRadius, style: .continuous))
                        .ylGlassRounded(cornerRadius: ChatWidgetChrome.glassRadius, interactive: true)
                        .modifier(PlaceCardOpenMaps(pin: widget.type == "place" ? pin(for: widget) : nil))
                        .id(widget.id)
                }
            }
            .padding(.horizontal, leadingInset)
            .padding(.vertical, Self.bloomPad)
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $focusedId)
        .frame(maxWidth: .infinity)
        .scrollClipDisabled()
        .opacity(queued ? 0.42 : 1)
        .fullScreenCover(isPresented: $expandedMap) {
            ChatMapExpandedView(
                pins: mapPins,
                onSelectPin: { pinId in
                    if let match = widgets.first(where: { $0.pinId == pinId || $0.id == pinId }) {
                        focusedId = match.id
                    }
                },
                onClose: { expandedMap = false }
            )
        }
    }

    private func cardWidth(in containerWidth: CGFloat) -> CGFloat {
        let width = containerWidth > 1 ? containerWidth : UIScreen.main.bounds.width
        let peek = widgets.count > 1 ? Self.nextCardPeek : leadingInset
        return max(240, width - leadingInset - peek)
    }

    private func html(for widget: ChatWidget) -> String {
        if colorScheme == .dark {
            let dark = widget.htmlDark?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !dark.isEmpty { return dark }
        }
        return widget.html ?? ""
    }

    @ViewBuilder
    private func card(_ widget: ChatWidget) -> some View {
        switch widget.type {
        case "map":
            ChatMapPreview(pins: widget.pins ?? []) {
                expandedMap = true
            }
            .equatable()
            .frame(height: 200)
            .clipShape(RoundedRectangle(cornerRadius: ChatWidgetChrome.innerRadius, style: .continuous))
            .padding(ChatWidgetChrome.contentPad)
        case "image":
            ChatImageWidget(url: widget.url ?? "", alt: widget.alt ?? "")
                .padding(ChatWidgetChrome.contentPad)
        case "place":
            ChatPlaceWidget(
                title: widget.title ?? widget.pinId ?? "Place",
                subtitle: widget.subtitle ?? "",
                detail: widget.body ?? ""
            )
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        default:
            ChatHtmlWidget(
                html: html(for: widget),
                height: htmlHeights[widget.id] ?? 160
            ) { htmlHeights[widget.id] = $0 }
            .frame(height: min(max(htmlHeights[widget.id] ?? 160, 80), 360))
            .clipShape(RoundedRectangle(cornerRadius: ChatWidgetChrome.innerRadius, style: .continuous))
            .padding(.top, ChatWidgetChrome.contentPad)
            .padding(.horizontal, ChatWidgetChrome.contentPad)
            .padding(.bottom, ChatWidgetChrome.htmlBottomPad)
        }
    }

    private func pin(for widget: ChatWidget) -> ChatMapPin? {
        let key = widget.pinId ?? widget.id
        if let match = mapPins.first(where: { $0.id == key }) { return match }
        if let title = widget.title, let match = mapPins.first(where: { $0.title == title }) {
            return match
        }
        return nil
    }
}

private struct PlaceCardOpenMaps: ViewModifier {
    let pin: ChatMapPin?

    func body(content: Content) -> some View {
        if let pin {
            content
                .overlay {
                    Color.clear
                        .contentShape(
                            RoundedRectangle(
                                cornerRadius: ChatWidgetChrome.glassRadius,
                                style: .continuous
                            )
                        )
                        .onTapGesture {
                            YLHaptics.tap()
                            ChatAppleMaps.open(pin)
                        }
                        .accessibilityHidden(true)
                }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Opens in Maps")
                .accessibilityAction {
                    YLHaptics.tap()
                    ChatAppleMaps.open(pin)
                }
        } else {
            content
        }
    }
}

private struct ChatPlaceWidget: View {
    let title: String
    let subtitle: String
    /// Longer description text (named to avoid clashing with SwiftUI `body`).
    let detail: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundStyle(YLTheme.fg(colorScheme))
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(YLTheme.muted(colorScheme))
            }
            if !detail.isEmpty, detail != subtitle {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 140, alignment: .topLeading)
    }
}

private struct ChatImageWidget: View {
    let url: String
    let alt: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let href = URL(string: url), href.scheme?.lowercased() == "https" {
                AsyncImage(url: href) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                    case .failure:
                        Text(alt.isEmpty ? "Image unavailable" : alt)
                            .font(.footnote)
                            .foregroundStyle(YLTheme.muted(colorScheme))
                            .frame(maxWidth: .infinity, minHeight: 120)
                    default:
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 120)
                    }
                }
            } else {
                Text(alt.isEmpty ? "Image unavailable" : alt)
                    .font(.footnote)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .frame(maxHeight: 240)
        .clipShape(RoundedRectangle(cornerRadius: ChatWidgetChrome.innerRadius, style: .continuous))
        .accessibilityLabel(alt.isEmpty ? "Image" : alt)
    }
}

/// Static map card. SwiftUI `Map(position:)` reloads tiles whenever a parent
/// redraws (chat poll / Working dots), so this is a plain MKMapView that only
/// updates when pins actually change.
private struct ChatMapPreview: View, Equatable {
    let pins: [ChatMapPin]
    var onExpand: () -> Void

    static func == (lhs: ChatMapPreview, rhs: ChatMapPreview) -> Bool {
        lhs.pins == rhs.pins
    }

    var body: some View {
        ZStack {
            ChatMapKitRepresentable(pins: pins, interactive: false)
                .allowsHitTesting(false)
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    YLHaptics.tap()
                    onExpand()
                }
        }
        .accessibilityLabel("Map with \(pins.count) places")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens a larger map")
    }
}

private struct ChatMapKitRepresentable: UIViewRepresentable {
    let pins: [ChatMapPin]
    var interactive: Bool
    var satellite: Bool = false
    var trackingMode: Binding<MKUserTrackingMode>? = nil
    var onSelectPin: ((String) -> Void)? = nil
    var onSelectMapsPin: ((ChatMapPin?) -> Void)? = nil
    var onMap: ((MKMapView) -> Void)? = nil

    func makeCoordinator() -> ChatMapCoordinator {
        ChatMapCoordinator(interactive: interactive, onSelectPin: onSelectPin)
    }

    func makeUIView(context: Context) -> ChatSizedMapView {
        let map = ChatSizedMapView(frame: .zero)
        context.coordinator.configure(map)
        context.coordinator.trackingBinding = trackingMode
        context.coordinator.onSelectMapsPin = onSelectMapsPin
        context.coordinator.applyMapStyle(satellite: satellite, on: map)
        context.coordinator.sync(pins: pins, on: map, animated: false)
        DispatchQueue.main.async { onMap?(map) }
        return map
    }

    func updateUIView(_ map: ChatSizedMapView, context: Context) {
        context.coordinator.onSelectPin = onSelectPin
        context.coordinator.onSelectMapsPin = onSelectMapsPin
        context.coordinator.trackingBinding = trackingMode
        context.coordinator.applyMapStyle(satellite: satellite, on: map)
        if interactive, let desired = trackingMode?.wrappedValue, map.userTrackingMode != desired {
            map.setUserTrackingMode(desired, animated: true)
        }
        context.coordinator.sync(pins: pins, on: map, animated: false)
    }

    static func dismantleUIView(_ uiView: ChatSizedMapView, coordinator: ChatMapCoordinator) {
        coordinator.cancelResolve()
        coordinator.onSelectMapsPin?(nil)
    }
}

private final class ChatMapCoordinator: NSObject, MKMapViewDelegate {
    let interactive: Bool
    var onSelectPin: ((String) -> Void)?
    var onSelectMapsPin: ((ChatMapPin?) -> Void)?
    var trackingBinding: Binding<MKUserTrackingMode>?
    private var lastPinKey = ""
    private var didFitUser = false
    private var lastSatellite: Bool?
    private var syncedPins: [ChatMapPin] = []
    private var pinIdsByAnnotation: [ObjectIdentifier: String] = [:]
    private var resolveTask: Task<Void, Never>?
    private var resolveGeneration = 0

    init(interactive: Bool, onSelectPin: ((String) -> Void)?) {
        self.interactive = interactive
        self.onSelectPin = onSelectPin
        super.init()
    }

    func cancelResolve() {
        resolveGeneration += 1
        resolveTask?.cancel()
        resolveTask = nil
    }

    func configure(_ map: ChatSizedMapView) {
        map.delegate = self
        map.isRotateEnabled = interactive
        map.isPitchEnabled = interactive
        map.isScrollEnabled = interactive
        map.isZoomEnabled = interactive
        map.isUserInteractionEnabled = interactive
        map.showsCompass = false
        map.showsScale = false
        map.showsTraffic = false
        map.showsUserLocation = true
        map.pointOfInterestFilter = .includingAll
        map.register(MKMarkerAnnotationView.self, forAnnotationViewWithReuseIdentifier: "pin")
    }

    func sync(pins: [ChatMapPin], on map: ChatSizedMapView, animated: Bool) {
        let key = pins.map { "\($0.id):\($0.lat):\($0.lng):\($0.title)" }.joined(separator: "|")
        guard key != lastPinKey else { return }
        lastPinKey = key
        didFitUser = false
        syncedPins = pins
        pinIdsByAnnotation.removeAll()
        onSelectMapsPin?(nil)
        map.removeAnnotations(map.annotations.filter { !($0 is MKUserLocation) })
        for (index, pin) in pins.enumerated() {
            map.addAnnotation(ChatPinAnnotation(pin: pin, colorIndex: index))
        }
        map.applyRegion(ChatMapRegion.fitting(pins, user: ChatMapRegion.userCoordinate(from: map)), animated: animated)
        resolvePlaces(pins, on: map)
    }

    private func resolvePlaces(_ pins: [ChatMapPin], on map: ChatSizedMapView) {
        resolveGeneration += 1
        let generation = resolveGeneration
        resolveTask?.cancel()
        resolveTask = Task { [weak self, weak map] in
            let items = await ChatPlaceResolver.shared.items(for: pins)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, let map, self.resolveGeneration == generation else { return }
                self.applyResolved(items, pins: pins, on: map)
            }
        }
    }

    private func applyResolved(_ items: [String: MKMapItem], pins: [ChatMapPin], on map: ChatSizedMapView) {
        guard !items.isEmpty else { return }
        pinIdsByAnnotation.removeAll()
        map.removeAnnotations(map.annotations.filter { !($0 is MKUserLocation) })
        var displayPins = pins
        for (index, pin) in pins.enumerated() {
            if let item = items[pin.id] {
                let coord = item.chatCoordinate
                if CLLocationCoordinate2DIsValid(coord) {
                    displayPins[index].lat = coord.latitude
                    displayPins[index].lng = coord.longitude
                }
                if let annotation = MKMapItemAnnotation(mapItem: item) {
                    pinIdsByAnnotation[ObjectIdentifier(annotation)] = pin.id
                    map.addAnnotation(annotation)
                    continue
                }
            }
            map.addAnnotation(ChatPinAnnotation(pin: displayPins[index], colorIndex: index))
        }
        syncedPins = displayPins
    }

    func applyMapStyle(satellite: Bool, on map: ChatSizedMapView) {
        guard lastSatellite != satellite else { return }
        lastSatellite = satellite
        if satellite {
            map.preferredConfiguration = MKImageryMapConfiguration(elevationStyle: .realistic)
        } else {
            let config = MKStandardMapConfiguration(elevationStyle: .realistic)
            config.pointOfInterestFilter = .includingAll
            map.preferredConfiguration = config
        }
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        if annotation is MKUserLocation || annotation is MKMapItemAnnotation { return nil }
        guard let pin = annotation as? ChatPinAnnotation else { return nil }
        let view = mapView.dequeueReusableAnnotationView(
            withIdentifier: "pin",
            for: annotation
        ) as? MKMarkerAnnotationView
        view?.markerTintColor = ChatMapPinPalette.uiColor(at: pin.colorIndex)
        view?.canShowCallout = false
        view?.displayPriority = .required
        view?.titleVisibility = .visible
        view?.subtitleVisibility = interactive ? .adaptive : .hidden
        return view
    }

    func mapView(_ mapView: MKMapView, didAdd views: [MKAnnotationView]) {
        for view in views {
            view.canShowCallout = false
        }
    }

    func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
        let pinId: String?
        if let pin = annotation as? ChatPinAnnotation {
            pinId = pin.pinId
        } else {
            pinId = pinIdsByAnnotation[ObjectIdentifier(annotation as AnyObject)]
        }
        guard let pinId else { return }
        onSelectPin?(pinId)
        guard interactive else { return }
        onSelectMapsPin?(syncedPins.first(where: { $0.id == pinId }))
    }

    func mapView(_ mapView: MKMapView, didDeselect annotation: MKAnnotation) {
        onSelectMapsPin?(nil)
    }

    func mapView(_ mapView: MKMapView, didUpdate userLocation: MKUserLocation) {
        guard !didFitUser, let map = mapView as? ChatSizedMapView else { return }
        didFitUser = true
        let coord = userLocation.coordinate
        let visible = map.region
        let inView =
            abs(coord.latitude - visible.center.latitude) <= visible.span.latitudeDelta / 2
            && abs(coord.longitude - visible.center.longitude) <= visible.span.longitudeDelta / 2
        if inView { return }
        map.applyRegion(ChatMapRegion.fitting(syncedPins, user: coord), animated: interactive)
    }

    func mapView(_ mapView: MKMapView, didChange mode: MKUserTrackingMode, animated: Bool) {
        if trackingBinding?.wrappedValue != mode {
            trackingBinding?.wrappedValue = mode
        }
    }
}

/// Applies camera after the view has a real size; ignores later no-op updates.
private final class ChatSizedMapView: MKMapView {
    private var pendingRegion: MKCoordinateRegion?
    private var pendingAnimated = false

    func applyRegion(_ region: MKCoordinateRegion, animated: Bool) {
        if bounds.width > 1 {
            pendingRegion = nil
            setRegion(region, animated: animated)
        } else {
            pendingRegion = region
            pendingAnimated = animated
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 1, let region = pendingRegion else { return }
        pendingRegion = nil
        setRegion(region, animated: pendingAnimated)
    }
}

private struct ChatMapExpandedView: View {
    let pins: [ChatMapPin]
    var onSelectPin: (String) -> Void
    var onClose: () -> Void

    @State private var trackingMode: MKUserTrackingMode = .none
    @State private var satellite = false
    @State private var mapView: MKMapView?
    @State private var mapsPin: ChatMapPin?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            ZStack {
                ChatMapKitRepresentable(
                    pins: pins,
                    interactive: true,
                    satellite: satellite,
                    trackingMode: $trackingMode,
                    onSelectPin: onSelectPin,
                    onSelectMapsPin: { mapsPin = $0 },
                    onMap: { mapView = $0 }
                )
                .ignoresSafeArea()

                VStack {
                    HStack {
                        Spacer()
                        VStack(spacing: 10) {
                            Button {
                                YLHaptics.tap()
                                satellite.toggle()
                            } label: {
                                Image(systemName: "map")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(YLTheme.fg(colorScheme))
                                    .frame(width: 44, height: 44)
                                    .contentShape(Circle())
                            }
                            .buttonStyle(.plain)
                            .ylSizedGlassCircle(side: 44)
                            .accessibilityLabel("Map style")
                            .accessibilityValue(satellite ? "Satellite" : "Standard")

                            if let mapView {
                                ChatCompassButton(map: mapView)
                                    .frame(width: 40, height: 40)
                            }
                        }
                        .padding(.trailing, 16)
                        .padding(.top, 8)
                    }
                    Spacer()
                    HStack(alignment: .center) {
                        Color.clear.frame(width: 44, height: 44)
                        Spacer(minLength: 0)
                        if let mapsPin {
                            Button("Open in Maps") {
                                YLHaptics.tap()
                                ChatAppleMaps.open(mapsPin)
                            }
                            .font(.system(size: 17, weight: .semibold))
                            .ylGlassButton(shape: .capsule)
                        }
                        Spacer(minLength: 0)
                        Button {
                            YLHaptics.tap()
                            cycleTracking()
                        } label: {
                            Image(systemName: trackingSymbol)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .frame(width: 44, height: 44)
                                .contentShape(Circle())
                        }
                        .buttonStyle(.plain)
                        .ylSizedGlassCircle(side: 44)
                        .accessibilityLabel("Current location")
                        .accessibilityValue(trackingValue)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { onClose() }
                }
            }
            .navigationTitle("Map")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var trackingSymbol: String {
        switch trackingMode {
        case .follow: return "location.fill"
        case .followWithHeading: return "location.north.line.fill"
        default: return "location"
        }
    }

    private var trackingValue: String {
        switch trackingMode {
        case .follow: return "Following"
        case .followWithHeading: return "Following heading"
        default: return "Off"
        }
    }

    private func cycleTracking() {
        switch trackingMode {
        case .none: trackingMode = .follow
        case .follow: trackingMode = .followWithHeading
        default: trackingMode = .none
        }
    }
}

private struct ChatCompassButton: UIViewRepresentable {
    let map: MKMapView

    func makeUIView(context: Context) -> MKCompassButton {
        let button = MKCompassButton(mapView: map)
        button.compassVisibility = .visible
        return button
    }

    func updateUIView(_ uiView: MKCompassButton, context: Context) {
        uiView.mapView = map
    }
}

private enum ChatAppleMaps {
    static func open(_ pin: ChatMapPin) {
        Task { @MainActor in
            if let item = await ChatPlaceResolver.shared.item(for: pin) {
                item.openInMaps(launchOptions: nil)
                return
            }
            openDroppedPin(pin)
        }
    }

    private static func openDroppedPin(_ pin: ChatMapPin) {
        let item: MKMapItem
        if #available(iOS 26, *) {
            item = MKMapItem(
                location: CLLocation(latitude: pin.lat, longitude: pin.lng),
                address: nil
            )
        } else {
            item = MKMapItem(placemark: MKPlacemark(coordinate: pin.coordinate))
        }
        item.name = pin.title
        item.openInMaps(launchOptions: [
            MKLaunchOptionsMapCenterKey: NSValue(mkCoordinate: pin.coordinate),
            MKLaunchOptionsMapSpanKey: NSValue(
                mkCoordinateSpan: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
            ),
        ])
    }
}

/// Looks up Apple Maps places for an agent pin (name + nearby coords). Session-cached.
private actor ChatPlaceResolver {
    static let shared = ChatPlaceResolver()

    private var cache: [String: MKMapItem?] = [:]
    private var inFlight: [String: Task<MKMapItem?, Never>] = [:]

    func item(for pin: ChatMapPin) async -> MKMapItem? {
        let title = pin.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        let key = Self.cacheKey(for: pin)
        if let cached = cache[key] { return cached }
        if let existing = inFlight[key] { return await existing.value }
        let task = Task { await Self.search(pin) }
        inFlight[key] = task
        let result = await task.value
        cache[key] = result
        inFlight[key] = nil
        return result
    }

    func items(for pins: [ChatMapPin]) async -> [String: MKMapItem] {
        await withTaskGroup(of: (String, MKMapItem?).self) { group in
            for pin in pins {
                group.addTask { (pin.id, await self.item(for: pin)) }
            }
            var out: [String: MKMapItem] = [:]
            for await (id, item) in group {
                if let item { out[id] = item }
            }
            return out
        }
    }

    private static func cacheKey(for pin: ChatMapPin) -> String {
        let lat = (pin.lat * 1000).rounded() / 1000
        let lng = (pin.lng * 1000).rounded() / 1000
        return "v4|\(pin.title.lowercased())|\(lat)|\(lng)"
    }

    private static func search(_ pin: ChatMapPin) async -> MKMapItem? {
        let region = MKCoordinateRegion(
            center: pin.coordinate,
            latitudinalMeters: 2500,
            longitudinalMeters: 2500
        )
        let request = MKLocalSearch.Request(naturalLanguageQuery: pin.title, region: region)
        do {
            let response = try await MKLocalSearch(request: request).start()
            return ChatPlaceMatch.best(in: response.mapItems, for: pin)
        } catch {
            return nil
        }
    }
}

private enum ChatPlaceMatch {
    static let nearMeters: CLLocationDistance = 600
    static let exactNearMeters: CLLocationDistance = 1500
    static let rankedNearMeters: CLLocationDistance = 800

    static func best(in items: [MKMapItem], for pin: ChatMapPin) -> MKMapItem? {
        let query = normalize(pin.title)
        guard query.count >= 2 else { return nil }
        let queryTokens = tokens(query)
        let origin = CLLocation(latitude: pin.lat, longitude: pin.lng)
        var best: (item: MKMapItem, distance: CLLocationDistance, score: Int)?

        for item in items {
            let names = displayNames(item)
            let coord = item.chatCoordinate
            guard CLLocationCoordinate2DIsValid(coord) else { continue }
            let distance = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
                .distance(from: origin)
            let hit = names.contains { namesMatch(query: query, queryTokens: queryTokens, name: $0) }
            let exact = names.contains { $0 == query }
            let maxDistance = exact ? exactNearMeters : nearMeters
            guard hit, distance <= maxDistance else { continue }
            let score = exact ? 2 : 1
            if let current = best {
                if score > current.score || (score == current.score && distance < current.distance) {
                    best = (item, distance, score)
                }
            } else {
                best = (item, distance, score)
            }
        }
        if let best { return best.item }
        guard let first = items.first else { return nil }
        let coord = first.chatCoordinate
        guard CLLocationCoordinate2DIsValid(coord) else { return nil }
        let distance = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
            .distance(from: origin)
        return distance <= rankedNearMeters ? first : nil
    }

    private static func displayNames(_ item: MKMapItem) -> [String] {
        var names: [String] = []
        if let name = item.name { names.append(normalize(name)) }
        names.append(normalize(item.placemark.title ?? ""))
        names.append(normalize(item.placemark.name ?? ""))
        return names.filter { !$0.isEmpty }
    }

    private static func namesMatch(query: String, queryTokens: [String], name: String) -> Bool {
        if name == query { return true }
        if name.hasPrefix(query + " ") || name.hasSuffix(" " + query) { return true }
        let nameTokens = tokens(name)
        if nameTokens.contains(query) { return true }
        if queryTokens.count >= 2 {
            return queryTokens.allSatisfy { name.contains($0) }
        }
        return query.count >= 4 && (name.hasPrefix(query) || name.contains(" " + query))
    }

    private static func normalize(_ raw: String) -> String {
        let folded = raw.lowercased()
            .folding(options: [.diacriticInsensitive, .widthInsensitive], locale: .current)
            .replacingOccurrences(of: "&", with: " and ")
        var chars: [Character] = []
        chars.reserveCapacity(folded.count)
        for ch in folded {
            chars.append((ch.isLetter || ch.isNumber || ch.isWhitespace) ? ch : " ")
        }
        return String(chars)
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    private static func tokens(_ normalized: String) -> [String] {
        normalized.split(separator: " ").map(String.init).filter { $0.count >= 2 }
    }
}

private extension MKMapItem {
    var chatCoordinate: CLLocationCoordinate2D {
        if #available(iOS 26, *) {
            return location.coordinate
        }
        return placemark.coordinate
    }
}

private enum ChatMapPinPalette {
    static let uiColors: [UIColor] = [
        .systemRed,
        .systemBlue,
        .systemGreen,
        .systemOrange,
        .systemPurple,
        .systemTeal,
        .systemPink,
        .systemIndigo,
        .systemMint,
        .systemBrown,
        .systemCyan,
        .systemYellow,
    ]

    static func uiColor(at index: Int) -> UIColor {
        uiColors[index % uiColors.count]
    }
}

private final class ChatPinAnnotation: MKPointAnnotation {
    let pin: ChatMapPin
    let colorIndex: Int
    var pinId: String { pin.id }

    init(pin: ChatMapPin, colorIndex: Int) {
        self.pin = pin
        self.colorIndex = colorIndex
        super.init()
        title = pin.title
        subtitle = pin.subtitle.isEmpty ? nil : pin.subtitle
        coordinate = pin.coordinate
    }
}

private enum ChatMapRegion {
    static func userCoordinate(from map: MKMapView) -> CLLocationCoordinate2D? {
        if let coord = map.userLocation.location?.coordinate, CLLocationCoordinate2DIsValid(coord) {
            return coord
        }
        guard let fix = PhoneLocationReporter.shared.snapshot else { return nil }
        let coord = CLLocationCoordinate2D(latitude: fix.latitude, longitude: fix.longitude)
        return CLLocationCoordinate2DIsValid(coord) ? coord : nil
    }

    static func fitting(_ pins: [ChatMapPin], user: CLLocationCoordinate2D? = nil) -> MKCoordinateRegion {
        var points: [(Double, Double)] = pins.map { ($0.lat, $0.lng) }
        if let user, CLLocationCoordinate2DIsValid(user), shouldInclude(user, with: pins) {
            points.append((user.latitude, user.longitude))
        }
        guard let first = points.first else {
            if let user, CLLocationCoordinate2DIsValid(user) {
                return MKCoordinateRegion(
                    center: user,
                    span: MKCoordinateSpan(latitudeDelta: 0.04, longitudeDelta: 0.04)
                )
            }
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 47.6062, longitude: -122.3321),
                span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
            )
        }
        var minLat = first.0
        var maxLat = first.0
        var minLng = first.1
        var maxLng = first.1
        for point in points {
            minLat = min(minLat, point.0)
            maxLat = max(maxLat, point.0)
            minLng = min(minLng, point.1)
            maxLng = max(maxLng, point.1)
        }
        let center = CLLocationCoordinate2D(
            latitude: (minLat + maxLat) / 2,
            longitude: (minLng + maxLng) / 2
        )
        let latDelta = max((maxLat - minLat) * 1.6, 0.01)
        let lngDelta = max((maxLng - minLng) * 1.6, 0.01)
        return MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(latitudeDelta: latDelta, longitudeDelta: lngDelta)
        )
    }

    /// Keep the camera on the places unless the user is nearby enough to belong on the same map.
    private static func shouldInclude(_ user: CLLocationCoordinate2D, with pins: [ChatMapPin]) -> Bool {
        guard !pins.isEmpty else { return true }
        let pad = 0.4
        let minLat = pins.map(\.lat).min()! - pad
        let maxLat = pins.map(\.lat).max()! + pad
        let minLng = pins.map(\.lng).min()! - pad
        let maxLng = pins.map(\.lng).max()! + pad
        return (minLat...maxLat).contains(user.latitude) && (minLng...maxLng).contains(user.longitude)
    }
}

private extension ChatMapPin {
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

private struct ChatHtmlWidget: UIViewRepresentable {
    let html: String
    var height: CGFloat
    var onHeight: (CGFloat) -> Void
    @Environment(\.colorScheme) private var colorScheme

    /// One ephemeral store for every HTML card. A fresh `.nonPersistent()`
    /// per card spins up its own WebKit session/network machinery — expensive
    /// when a restored chat mounts several cards at launch (still ephemeral).
    private static let sharedDataStore = WKWebsiteDataStore.nonPersistent()

    func makeCoordinator() -> Coordinator {
        Coordinator(onHeight: onHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = Self.sharedDataStore
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "resize")
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.insetsLayoutMarginsFromSafeArea = false
        view.scrollView.isScrollEnabled = false
        view.scrollView.backgroundColor = .clear
        view.scrollView.contentInset = .zero
        view.scrollView.scrollIndicatorInsets = .zero
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.insetsLayoutMarginsFromSafeArea = false
        Self.clipToInnerRadius(view)
        view.navigationDelegate = context.coordinator
        context.coordinator.load(html: html, colorScheme: colorScheme, in: view)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        Self.clipToInnerRadius(uiView)
        context.coordinator.onHeight = onHeight
        if context.coordinator.lastHTML != html || context.coordinator.lastScheme != colorScheme {
            context.coordinator.load(html: html, colorScheme: colorScheme, in: uiView)
        }
    }

    private static func clipToInnerRadius(_ view: WKWebView) {
        let radius = ChatWidgetChrome.innerRadius
        view.clipsToBounds = true
        view.layer.cornerRadius = radius
        view.layer.cornerCurve = .continuous
        view.scrollView.clipsToBounds = true
        view.scrollView.layer.cornerRadius = radius
        view.scrollView.layer.cornerCurve = .continuous
        view.scrollView.backgroundColor = .clear
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "resize")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var onHeight: (CGFloat) -> Void
        var lastHTML = ""
        var lastScheme: ColorScheme?

        init(onHeight: @escaping (CGFloat) -> Void) {
            self.onHeight = onHeight
        }

        func load(html: String, colorScheme: ColorScheme, in webView: WKWebView) {
            lastHTML = html
            lastScheme = colorScheme
            let fg = colorScheme == .dark ? "#E9EEF2" : "#14181D"
            let radius = Int(ChatWidgetChrome.innerRadius)
            let page = """
            <!DOCTYPE html>
            <html>
            <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
            <style>
              html, body {
                margin: 0;
                padding: 0;
                background: transparent;
                color: \(fg);
                font: 15px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
                overflow: hidden;
                border-radius: \(radius)px;
              }
              body > * {
                border-radius: \(radius)px !important;
                overflow: hidden;
              }
              img { max-width: 100%; height: auto; }
              a { color: inherit; }
            </style>
            </head>
            <body>
            \(html)
            <script>
            function report() {
              var h = 0;
              var children = document.body.children;
              for (var i = 0; i < children.length; i++) {
                if (children[i].tagName === 'SCRIPT') continue;
                var bottom = children[i].getBoundingClientRect().bottom;
                if (bottom > h) h = bottom;
              }
              if (h < 1) {
                h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
              }
              if (window.webkit && window.webkit.messageHandlers.resize) {
                window.webkit.messageHandlers.resize.postMessage(Math.ceil(h));
              }
            }
            new ResizeObserver(report).observe(document.body);
            window.addEventListener('load', report);
            report();
            </script>
            </body>
            </html>
            """
            webView.loadHTMLString(page, baseURL: nil)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "resize" else { return }
            let value: CGFloat
            if let n = message.body as? CGFloat {
                value = n
            } else if let n = message.body as? Double {
                value = CGFloat(n)
            } else if let n = message.body as? Int {
                value = CGFloat(n)
            } else {
                return
            }
            let clipped = min(max(value, 80), 360)
            DispatchQueue.main.async { self.onHeight(clipped) }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url
            {
                let scheme = url.scheme?.lowercased() ?? ""
                if scheme == "https" || scheme == "http" {
                    UIApplication.shared.open(url)
                }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
