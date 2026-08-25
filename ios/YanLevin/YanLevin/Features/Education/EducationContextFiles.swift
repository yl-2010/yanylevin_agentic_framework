import QuickLook
import SwiftUI
import UIKit

/// Owner of a context-file folder (class / project / todo / date).
struct EducationFileOwner: Equatable {
    var scope: String
    var id: String?
    var classId: String? = nil
    var projectId: String? = nil
}

/// Liquid-glass file tiles. API order (pinned top, then newest mtime, then pinned bottom); tap opens Quick Look.
struct EducationContextFilesView: View {
    let files: [EducationContextFile]
    let owner: EducationFileOwner
    /// When true (todo/date detail on wide layouts), pack two tiles per row.
    var pairColumns: Bool = false
    @ObservedObject var store: EducationStore
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var educationFocus: EducationFocusStore
    @Environment(\.colorScheme) private var colorScheme

    @State private var previewItem: PreviewItem?
    @State private var openingName: String?
    @State private var openError: String?

    private var columns: [GridItem] {
        if pairColumns {
            return [
                GridItem(.flexible(), spacing: 14),
                GridItem(.flexible(), spacing: 14),
            ]
        }
        return [GridItem(.flexible(), spacing: 14)]
    }

    var body: some View {
        Group {
            if !files.isEmpty {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                    ForEach(files) { file in
                        Button {
                            open(file)
                        } label: {
                            Text(file.displayName)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(YLTheme.fg(colorScheme))
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 14)
                                .ylGlassRounded(cornerRadius: 22, interactive: true)
                                .opacity(openingName == file.name ? 0.55 : 1)
                        }
                        .buttonStyle(.plain)
                        .ylHapticOnTap()
                        .disabled(openingName != nil)
                        .accessibilityLabel("Open \(file.displayName)")
                    }
                }
                .sheet(item: $previewItem) { item in
                    EducationQuickLookPreview(url: item.url)
                        .ignoresSafeArea()
                }
                .alert("Couldn’t open file", isPresented: Binding(
                    get: { openError != nil },
                    set: { if !$0 { openError = nil } }
                )) {
                    Button("OK", role: .cancel) { openError = nil }
                } message: {
                    Text(openError ?? "")
                }
                .modifier(EducationFilePreviewDismiss(previewItem: $previewItem))
            }
        }
    }

    private func open(_ file: EducationContextFile) {
        guard let token = auth.session?.token else {
            openError = "Please sign in again."
            return
        }
        openingName = file.name
        Task {
            defer { openingName = nil }
            do {
                let url = try await store.downloadContextFile(
                    scope: owner.scope,
                    id: owner.id,
                    classId: owner.classId,
                    projectId: owner.projectId,
                    name: file.name,
                    token: token
                )
                previewItem = PreviewItem(url: url)
            } catch {
                openError = error.localizedDescription
            }
        }
    }
}

private struct PreviewItem: Identifiable, Equatable {
    let url: URL
    var id: String { url.path }
}

private struct EducationFilePreviewDismiss: ViewModifier {
    @Binding var previewItem: PreviewItem?
    @EnvironmentObject private var educationFocus: EducationFocusStore

    func body(content: Content) -> some View {
        content
            .onChange(of: previewItem) { _, item in
                educationFocus.filePreviewPresented = item != nil
            }
            .onChange(of: educationFocus.filePreviewDismissGeneration) { _, _ in
                previewItem = nil
            }
            .onDisappear {
                if previewItem != nil {
                    educationFocus.filePreviewPresented = false
                }
            }
    }
}

private struct EducationQuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        let nav = UINavigationController(rootViewController: preview)
        nav.navigationBar.prefersLargeTitles = false
        return nav
    }

    func updateUIViewController(_ uiViewController: UINavigationController, context: Context) {
        let coordinator = context.coordinator
        guard coordinator.url != url else { return }
        coordinator.url = url
        if let preview = uiViewController.topViewController as? QLPreviewController {
            preview.reloadData()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url)
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            url as NSURL
        }
    }
}
