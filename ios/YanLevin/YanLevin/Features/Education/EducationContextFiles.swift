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

/// Liquid-glass file tiles. API order (pinned top, then newest mtime, then pinned bottom).
/// Folders expand in place. Office files on OneDrive open in Word/Excel/PowerPoint.
/// Other files open Quick Look (a copy).
struct EducationContextFilesView: View {
    let files: [EducationContextFile]
    let owner: EducationFileOwner
    /// When true (todo/date detail on wide layouts), pack two tiles per row.
    var pairColumns: Bool = false
    @ObservedObject var store: EducationStore
    @EnvironmentObject private var auth: AuthStore

    @State private var previewItem: PreviewItem?
    @State private var openingName: String?
    @State private var openError: String?
    @State private var expandedIds: Set<String> = []

    private var columns: [GridItem] {
        if pairColumns {
            return [
                GridItem(.flexible(), spacing: 14),
                GridItem(.flexible(), spacing: 14),
            ]
        }
        return [GridItem(.flexible(), spacing: 14)]
    }

    @ViewBuilder
    var body: some View {
        if files.isEmpty {
            EmptyView()
        } else {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                ForEach(files) { file in
                    EducationContextFileCell(
                        file: file,
                        pairColumns: pairColumns,
                        expandedIds: $expandedIds,
                        openingName: openingName,
                        onOpen: open
                    )
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

    private func open(_ file: EducationContextFile) {
        if file.kind == "url" {
            if file.opensInOfficeApp {
                openInOffice(file)
                return
            }
            if let url = file.browserURL ?? URL(string: file.webUrl ?? "") {
                UIApplication.shared.open(url)
            }
            return
        }
        if file.opensInOfficeApp {
            openInOffice(file)
            return
        }
        openCopy(file)
    }

    private func openInOffice(_ file: EducationContextFile) {
        if let officeURL = OfficeDocument.url(from: file.officeUri),
           UIApplication.shared.canOpenURL(officeURL)
        {
            UIApplication.shared.open(officeURL, options: [:]) { ok in
                if !ok {
                    DispatchQueue.main.async { self.openOfficeFallback(file) }
                }
            }
            return
        }
        openOfficeFallback(file)
    }

    private func openOfficeFallback(_ file: EducationContextFile) {
        if let web = file.browserURL {
            UIApplication.shared.open(web)
            return
        }
        openCopy(file)
    }

    private func openCopy(_ file: EducationContextFile) {
        guard let token = auth.session?.token else {
            openError = "Please sign in again."
            return
        }
        openingName = file.id
        Task {
            defer { openingName = nil }
            do {
                let url = try await store.downloadContextFile(
                    scope: owner.scope,
                    id: owner.id,
                    classId: owner.classId,
                    projectId: owner.projectId,
                    name: file.name,
                    source: file.source,
                    path: file.path,
                    token: token
                )
                previewItem = PreviewItem(url: url)
            } catch {
                openError = error.localizedDescription
            }
        }
    }
}

private struct EducationContextFileCell: View {
    let file: EducationContextFile
    let pairColumns: Bool
    @Binding var expandedIds: Set<String>
    let openingName: String?
    let onOpen: (EducationContextFile) -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if file.isFolder {
            VStack(alignment: .leading, spacing: 10) {
                folderButton
                if expandedIds.contains(file.id) {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(file.files ?? []) { child in
                            EducationContextFileCell(
                                file: child,
                                pairColumns: pairColumns,
                                expandedIds: $expandedIds,
                                openingName: openingName,
                                onOpen: onOpen
                            )
                        }
                    }
                    .padding(.leading, 12)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .gridCellColumns(pairColumns ? 2 : 1)
        } else {
            fileButton
        }
    }

    private var folderButton: some View {
        let open = expandedIds.contains(file.id)
        return Button {
            withAnimation(.easeInOut(duration: 0.18)) {
                if open {
                    expandedIds.remove(file.id)
                } else {
                    expandedIds.insert(file.id)
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme).opacity(0.7))
                    .frame(width: 12)
                Text(file.displayName)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(YLTheme.fg(colorScheme))
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .ylGlassRounded(cornerRadius: 22, interactive: true)
        }
        .buttonStyle(.plain)
        .ylHapticOnTap()
        .accessibilityLabel(file.displayName)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }

    private var fileButton: some View {
        Button {
            onOpen(file)
        } label: {
            Text(file.displayName)
                .font(.body.weight(.semibold))
                .foregroundStyle(YLTheme.fg(colorScheme))
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .ylGlassRounded(cornerRadius: 22, interactive: true)
                .opacity(openingName == file.id ? 0.55 : 1)
        }
        .buttonStyle(.plain)
        .ylHapticOnTap()
        .disabled(openingName != nil)
        .accessibilityLabel("Open \(file.displayName)")
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

struct EducationQuickLookPreview: UIViewControllerRepresentable {
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
