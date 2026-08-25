import SwiftUI
import UIKit

/// Shared width / column helpers for iPhone portrait, landscape, and iPad.
enum AdaptiveLayout {
    static let pageMaxWidth: CGFloat = 1100
    static let chatMaxWidth: CGFloat = 760
    static let formMaxWidth: CGFloat = 560

    /// True device type — Plus/Max landscape is still `.phone` even when width is `.regular`.
    static var isPad: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    static var isPhone: Bool {
        UIDevice.current.userInterfaceIdiom == .phone
    }

    static func isRegularWidth(_ sizeClass: UserInterfaceSizeClass?) -> Bool {
        sizeClass == .regular
    }

    /// Two-column canvas: iPad / large-phone landscape (regular width), or any landscape (compact height).
    static func isWideLayout(
        horizontalSizeClass: UserInterfaceSizeClass?,
        verticalSizeClass: UserInterfaceSizeClass?
    ) -> Bool {
        horizontalSizeClass == .regular || verticalSizeClass == .compact
    }

    /// iPhone landscape (compact height). Do not use size-class width alone — Plus/Max are `.regular`.
    static func isPhoneLandscape(verticalSizeClass: UserInterfaceSizeClass?) -> Bool {
        isPhone && verticalSizeClass == .compact
    }

    static func pagePadding(wide: Bool) -> CGFloat {
        wide ? 32 : 20
    }

    static func sectionSpacing(wide: Bool) -> CGFloat {
        wide ? 44 : 36
    }

    /// Portfolio entry grids (Research, Building, Math, More) — 2 columns when wide.
    static func entryColumns(wide: Bool) -> [GridItem] {
        if wide {
            return [
                GridItem(.flexible(), spacing: 16),
                GridItem(.flexible(), spacing: 16)
            ]
        }
        return [GridItem(.flexible())]
    }

    /// Timeline stays a single column in every size class / orientation.
    static func timelineColumns() -> [GridItem] {
        [GridItem(.flexible())]
    }

    static func statColumns(wide: Bool) -> [GridItem] {
        if wide {
            return Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)
        }
        return [GridItem(.flexible()), GridItem(.flexible())]
    }
}

extension View {
    /// Centers content and caps width on iPad / regular-width layouts.
    func adaptiveReadableWidth(_ maxWidth: CGFloat, enabled: Bool = true) -> some View {
        Group {
            if enabled {
                self
                    .frame(maxWidth: maxWidth)
                    .frame(maxWidth: .infinity)
            } else {
                self
            }
        }
    }

    /// Stretch a card to fill its LazyVGrid cell so row neighbors share equal height.
    func equalHeightCard(alignment: Alignment = .topLeading) -> some View {
        frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
    }
}
