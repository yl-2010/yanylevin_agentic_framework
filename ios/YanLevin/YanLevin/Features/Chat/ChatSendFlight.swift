import SwiftUI

/// iMessage send: a clone of the user bubble springs from the composer field
/// into the transcript. Scale and position only, never width/height (that
/// reflows the text mid-flight).
enum ChatSendFlightMotion {
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.72)
    /// Fallback if the dest row never reports a frame (lazy stack / missed layout).
    static let timeoutNanoseconds: UInt64 = 1_200_000_000
}

struct ChatSendFlightPending: Equatable {
    var generation: Int
    var origin: CGRect
}

struct ChatSendFlightState: Equatable {
    var generation: Int
    var messageID: UUID
    var text: String
    var origin: CGRect
    var dest: CGRect?
    var progress: CGFloat
}

/// Same chrome as a user `ChatBubbleView`. Duplicate, not a restyle.
struct ChatSendFlightBubble: View {
    let text: String
    let colorScheme: ColorScheme

    var body: some View {
        let sendTint = YLTheme.chatSend(colorScheme)
            .opacity(colorScheme == .dark ? 0.26 : 0.16)
        Text(text)
            .foregroundStyle(YLTheme.fg(colorScheme))
            .padding(12)
            .ylGlassRounded(
                cornerRadius: 22,
                tint: sendTint,
                interactive: true
            )
    }
}

struct ChatSendFlightOverlay: View {
    let flight: ChatSendFlightState
    let colorScheme: ColorScheme
    @State private var bubbleSize: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            let overlayGlobal = geo.frame(in: .global)
            let startAnchor = CGPoint(x: flight.origin.maxX, y: flight.origin.maxY)
            let endAnchor = flight.dest.map { CGPoint(x: $0.maxX, y: $0.maxY) } ?? startAnchor
            let t = flight.dest == nil ? 0 : flight.progress
            let anchor = CGPoint(
                x: startAnchor.x + (endAnchor.x - startAnchor.x) * t,
                y: startAnchor.y + (endAnchor.y - startAnchor.y) * t
            )
            let destHeight = flight.dest?.height ?? max(flight.origin.height, 1)
            let startScale = min(0.92, flight.origin.height / destHeight)
            let scale = flight.dest == nil ? startScale : startScale + (1 - startScale) * t
            let wrapWidth = flight.dest?.width ?? max(flight.origin.width, 1)
            let width = flight.dest?.width ?? (bubbleSize.width > 1 ? bubbleSize.width : wrapWidth)
            let height = flight.dest?.height ?? (bubbleSize.height > 1 ? bubbleSize.height : destHeight)
            ChatSendFlightBubble(text: flight.text, colorScheme: colorScheme)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: wrapWidth, alignment: .trailing)
                .onGeometryChange(for: CGSize.self) { proxy in
                    proxy.size
                } action: { size in
                    if abs(size.width - bubbleSize.width) > 0.5
                        || abs(size.height - bubbleSize.height) > 0.5
                    {
                        bubbleSize = size
                    }
                }
                .scaleEffect(scale, anchor: .bottomTrailing)
                .position(
                    x: anchor.x - overlayGlobal.minX - width / 2,
                    y: anchor.y - overlayGlobal.minY - height / 2
                )
                .accessibilityHidden(true)
        }
        .allowsHitTesting(false)
    }
}
