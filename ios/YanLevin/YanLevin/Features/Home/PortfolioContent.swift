import Foundation

struct PortfolioContent {
    struct Stat: Identifiable {
        let id = UUID()
        let value: String
        let label: String
    }

    struct TimelineItem: Identifiable {
        let id = UUID()
        let year: String
        let title: String
        let body: String
        let linkURL: URL?
        let linkLabel: String?

        init(
            year: String,
            title: String,
            body: String,
            linkURL: URL? = nil,
            linkLabel: String? = nil
        ) {
            self.year = year
            self.title = title
            self.body = body
            self.linkURL = linkURL
            self.linkLabel = linkLabel
        }
    }

    struct Entry: Identifiable {
        let id = UUID()
        let title: String
        let when: String?
        let body: String
        let linkURL: URL?
        let linkLabel: String?
        let secondaryLinkURL: URL?
        let secondaryLinkLabel: String?

        init(
            title: String,
            when: String?,
            body: String,
            linkURL: URL? = nil,
            linkLabel: String? = nil,
            secondaryLinkURL: URL? = nil,
            secondaryLinkLabel: String? = nil
        ) {
            self.title = title
            self.when = when
            self.body = body
            self.linkURL = linkURL
            self.linkLabel = linkLabel
            self.secondaryLinkURL = secondaryLinkURL
            self.secondaryLinkLabel = secondaryLinkLabel
        }
    }

    static let headline = "A personal agent that lives on your Mac."
    static let lede = "(PLACEHOLDER) Yan Levin. Open-source framework: Cursor agent, file-tree brain, education and fitness dashboards. Fork and rename before you sign this app."
    static let about = "This Home tab is the reference iOS shell. Replace this copy with your own. Set OWNER_EMAIL on the Mac API. Do not ship someone else's grades, bio, or photo."

    static let stats: [Stat] = [
        .init(value: "Mac", label: "Express API"),
        .init(value: "iOS", label: "reference app"),
        .init(value: "1", label: "operator"),
        .init(value: "MIT", label: "license"),
    ]

    static let timeline: [TimelineItem] = [
        .init(year: "Now", title: "Fork this repo", body: "Copy server/.env.example, set OWNER_EMAIL, rename education/you@example.com."),
        .init(year: "Next", title: "Rename the iOS target", body: "Change bundle ID, team, App Group, and display name before signing."),
    ]

    static let research: [Entry] = [
        .init(
            title: "Architecture",
            when: "docs/",
            body: "Static site optional on Vercel. Express on localhost :3004. Optional Cloudflare tunnel. LM Studio stays on localhost.",
            linkURL: URL(string: "https://github.com/yl-2010/yanylevin_agentic_framework"),
            linkLabel: "GitHub"
        ),
    ]

    static let building: [Entry] = []

    static let mathTeaching: [Entry] = []

    static let debateAwards: [String] = []

    static let more: [Entry] = []
}
