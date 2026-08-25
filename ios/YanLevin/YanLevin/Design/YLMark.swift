import SwiftUI

/// YL monogram from the site top-left logo.
struct YLMarkIcon: View {
    var body: some View {
        Image("YLMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(YLTheme.fg)
            .accessibilityHidden(true)
    }
}
