import SwiftUI

/// Square glass tile for one chat file. Draft tap removes it. Sent tap opens it.
struct ChatAttachmentTile: View {
    let name: String
    var displayName: String
    var uploading: Bool = false
    var opensOnTap: Bool = false
    var action: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    static let side: CGFloat = 64
    private static let cornerRadius: CGFloat = 16

    init(attachment: PendingChatAttachment, action: @escaping () -> Void) {
        self.name = attachment.name
        self.displayName = attachment.displayName
        self.uploading = attachment.uploading
        self.opensOnTap = false
        self.action = action
    }

    init(
        name: String,
        displayName: String? = nil,
        uploading: Bool = false,
        opensOnTap: Bool = false,
        action: @escaping () -> Void
    ) {
        self.name = name
        let shown = (displayName ?? name).trimmingCharacters(in: .whitespacesAndNewlines)
        self.displayName = shown.isEmpty ? name : shown
        self.uploading = uploading
        self.opensOnTap = opensOnTap
        self.action = action
    }

    private var extensionLabel: String {
        let ext = (name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? "file" : ".\(ext)"
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        Button {
            YLHaptics.tap()
            action()
        } label: {
            VStack(spacing: 2) {
                Spacer(minLength: 0)
                Text(extensionLabel)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                Text(displayName)
                    .font(.caption2)
                    .foregroundStyle(YLTheme.muted(colorScheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .foregroundStyle(YLTheme.fg(colorScheme))
            .padding(.horizontal, 6)
            .padding(.top, 6)
            .padding(.bottom, 7)
            .frame(width: Self.side, height: Self.side)
            .contentShape(shape)
            .ylGlassRounded(
                cornerRadius: Self.cornerRadius,
                tint: YLTheme.chatSend(colorScheme, palette: palette)
                    .opacity(colorScheme == .dark ? 0.32 : 0.26),
                interactive: true
            )
        }
        .buttonStyle(.plain)
        .opacity(uploading ? 0.55 : 1)
        .animation(.easeInOut(duration: 0.2), value: uploading)
        .accessibilityLabel("\(opensOnTap ? "Open" : "Remove") \(displayName)")
    }
}
