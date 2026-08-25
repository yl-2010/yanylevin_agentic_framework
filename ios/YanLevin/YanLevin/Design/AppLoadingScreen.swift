import SwiftUI

/// Matches `LaunchScreen.storyboard`: themed page color + flat YL mark.
struct AppLoadingScreen: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width * 0.28, 150)
            ZStack {
                YLTheme.bg0(colorScheme)
                    .ignoresSafeArea()
                Image("LaunchLogo")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: side, height: side)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Yan Levin")
    }
}
