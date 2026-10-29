import SwiftUI

/// Square composer tile for one pending attachment. Tapping it removes it.
struct ChatAttachmentTile: View {
    let attachment: PendingChatAttachment
    var onRemove: () -> Void

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.ylPalette) private var palette

    static let side: CGFloat = 64
    private static let cornerRadius: CGFloat = 16

    private var extensionLabel: String {
        let ext = (attachment.name as NSString).pathExtension.lowercased()
        return ext.isEmpty ? "file" : ".\(ext)"
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        Button {
            YLHaptics.tap()
            onRemove()
        } label: {
            VStack(spacing: 2) {
                Spacer(minLength: 0)
                Text(extensionLabel)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer(minLength: 0)
                Text(attachment.displayName)
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
        .opacity(attachment.uploading ? 0.55 : 1)
        .animation(.easeInOut(duration: 0.2), value: attachment.uploading)
        .accessibilityLabel("Remove \(attachment.displayName)")
    }
}
