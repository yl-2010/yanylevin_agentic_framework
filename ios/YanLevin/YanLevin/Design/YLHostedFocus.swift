import SwiftUI

/// Owns `@FocusState` inside a nested `UIHostingController` and mirrors it to a
/// parent `Binding` (chart hide, etc.).
struct YLHostedFocus<Content: View>: View {
    @Binding var isFocused: Bool
    @FocusState private var focused: Bool
    @ViewBuilder var content: (FocusState<Bool>.Binding) -> Content

    var body: some View {
        content($focused)
            .onChange(of: focused) { _, value in
                if isFocused != value { isFocused = value }
            }
            .onChange(of: isFocused) { _, value in
                if focused != value { focused = value }
            }
            .onAppear {
                if isFocused != focused { focused = isFocused }
            }
    }
}
