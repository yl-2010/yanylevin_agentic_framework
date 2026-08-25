import SwiftUI

struct HomeView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var isWide: Bool {
        AdaptiveLayout.isWideLayout(
            horizontalSizeClass: horizontalSizeClass,
            verticalSizeClass: verticalSizeClass
        )
    }

    /// Side-by-side hero needs real width (iPad / large landscape), not short-phone landscape.
    private var useSplitHero: Bool {
        AdaptiveLayout.isRegularWidth(horizontalSizeClass)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: AdaptiveLayout.sectionSpacing(wide: isWide)) {
                    hero
                    about
                    sectionTitle("Timeline")
                    timeline
                    sectionTitle("Research")
                    entries(PortfolioContent.research)
                    sectionTitle("Building")
                    entries(PortfolioContent.building)
                    sectionTitle("Math & Teaching")
                    entries(PortfolioContent.mathTeaching)
                    sectionTitle("Debate")
                    awards
                    sectionTitle("More")
                    entries(PortfolioContent.more)
                    footer
                }
                .padding(.horizontal, AdaptiveLayout.pagePadding(wide: isWide))
                .padding(.vertical, isWide ? 32 : 24)
                .adaptiveReadableWidth(AdaptiveLayout.pageMaxWidth)
            }
            .tabReselectScrollToTop(for: .home)
            .ylPageBackground()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Yan Levin")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(YLTheme.accent)
                }
            }
        }
    }

    private var hero: some View {
        Group {
            if useSplitHero {
                HStack(alignment: .center, spacing: 36) {
                    heroCopy
                        .frame(maxWidth: .infinity, alignment: .leading)
                    heroImage
                        .frame(maxWidth: 420)
                }
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    heroCopy
                    heroImage
                }
            }
        }
    }

    private var heroCopy: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(PortfolioContent.headline)
                .font(useSplitHero ? .system(size: 44, weight: .bold) : .largeTitle.weight(.bold))
                .foregroundStyle(YLTheme.fg)
            Text(PortfolioContent.lede)
                .font(useSplitHero ? .title3 : .body)
                .foregroundStyle(YLTheme.muted)
        }
    }

    private var heroImage: some View {
        Image("yan-levin")
            .resizable()
            .scaledToFill()
            .frame(maxWidth: .infinity)
            .frame(height: useSplitHero ? 360 : 280)
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    }

    private var about: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionTitle("About")
            Text(PortfolioContent.about)
                .font(useSplitHero ? .title3 : .body)
                .foregroundStyle(YLTheme.fg)
                .frame(maxWidth: useSplitHero ? 720 : .infinity, alignment: .leading)
            LazyVGrid(columns: AdaptiveLayout.statColumns(wide: isWide), spacing: 12) {
                ForEach(PortfolioContent.stats) { stat in
                    VStack(spacing: 4) {
                        Text(stat.value)
                            .font(.title.weight(.bold))
                            .foregroundStyle(YLTheme.fg)
                        Text(stat.label)
                            .font(.caption)
                            .foregroundStyle(YLTheme.muted)
                    }
                    .equalHeightCard(alignment: .center)
                    .padding(.vertical, 18)
                    .glassPanel(cornerRadius: 20)
                }
            }
        }
    }

    private var timeline: some View {
        LazyVGrid(columns: AdaptiveLayout.timelineColumns(), spacing: 14) {
            ForEach(PortfolioContent.timeline) { item in
                HStack(alignment: .top, spacing: 12) {
                    Text(item.year)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(YLTheme.accent)
                        .frame(width: 76, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title).font(.headline).foregroundStyle(YLTheme.fg)
                        Text(item.body).font(.subheadline).foregroundStyle(YLTheme.muted)
                        if let url = item.linkURL, let label = item.linkLabel {
                            Link(label, destination: url)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(YLTheme.accent)
                                .ylHapticOnTap()
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .glassPanel(cornerRadius: 16)
            }
        }
    }

    private func entries(_ items: [PortfolioContent.Entry]) -> some View {
        LazyVGrid(columns: AdaptiveLayout.entryColumns(wide: isWide), spacing: 12) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.title).font(.headline).foregroundStyle(YLTheme.fg)
                    if let when = item.when {
                        Text(when).font(.caption).foregroundStyle(YLTheme.accent)
                    }
                    Text(item.body).font(.subheadline).foregroundStyle(YLTheme.muted)
                    Spacer(minLength: 0)
                    HStack(spacing: 12) {
                        if let url = item.linkURL, let label = item.linkLabel {
                            Link(label, destination: url)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(YLTheme.accent)
                                .ylHapticOnTap()
                        }
                        if let url = item.secondaryLinkURL, let label = item.secondaryLinkLabel {
                            Link(label, destination: url)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(YLTheme.accent)
                                .ylHapticOnTap()
                        }
                    }
                }
                .equalHeightCard()
                .padding(14)
                .glassPanel(cornerRadius: 16)
            }
        }
    }

    private var awards: some View {
        Group {
            if isWide {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(PortfolioContent.debateAwards, id: \.self) { award in
                        Text("• \(award)")
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.fg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(18)
                .glassPanel(cornerRadius: 16)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(PortfolioContent.debateAwards, id: \.self) { award in
                        Text("• \(award)")
                            .font(.subheadline)
                            .foregroundStyle(YLTheme.fg)
                    }
                }
                .padding(14)
                .glassPanel(cornerRadius: 16)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Link("LinkedIn", destination: APIConfig.linkedinURL)
                .ylHapticOnTap()
            Link("GitHub", destination: APIConfig.githubURL)
                .ylHapticOnTap()
            Link("Email", destination: APIConfig.mailURL)
                .ylHapticOnTap()
            Text("© 2026 (PLACEHOLDER) Yan Levin")
                .font(.caption)
                .foregroundStyle(YLTheme.muted)
                .padding(.top, 4)
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(YLTheme.accent)
        .padding(.top, 8)
        .padding(.bottom, 40)
    }

    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.title2.weight(.bold))
            .foregroundStyle(YLTheme.fg)
    }
}
