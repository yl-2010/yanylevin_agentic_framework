import SwiftUI

/// Personal Agent markdown. Block views (tables, code, quotes, tasks) sit
/// inside the existing chat/detail liquid-glass container.
enum YLMarkdown {
    struct Parsed {
        var blocks: [Block]
        var footnotes: [(id: String, text: String)]
    }

    indirect enum Block {
        case paragraph(String)
        case heading(level: Int, text: String)
        case list([ListItem])
        case fence(String)
        case quote([Block])
        case table(headers: [String], rows: [[String]])
        case hr
    }

    struct ListItem {
        var text: String
        var children: [ListItem]
        var ordered: Bool
        var indent: Int
        var start: Int
        var taskChecked: Bool?
    }

    final class NoteContext {
        var order: [String] = []
        var ids: Set<String> = []

        init() {}

        init(ids: Set<String>, order: [String]) {
            self.ids = ids
            self.order = order
        }

        func number(for id: String) -> Int? {
            guard ids.contains(id) else { return nil }
            if let idx = order.firstIndex(of: id) { return idx + 1 }
            order.append(id)
            return order.count
        }
    }

    private final class CachedParse {
        let parsed: Parsed
        let ids: Set<String>
        let order: [String]

        init(parsed: Parsed, ids: Set<String>, order: [String]) {
            self.parsed = parsed
            self.ids = ids
            self.order = order
        }
    }

    private static let parseCache: NSCache<NSString, CachedParse> = {
        let cache = NSCache<NSString, CachedParse>()
        cache.countLimit = 64
        return cache
    }()

    static func parse(_ source: String) -> (Parsed, NoteContext) {
        let key = source as NSString
        if let cached = parseCache.object(forKey: key) {
            return (cached.parsed, NoteContext(ids: cached.ids, order: cached.order))
        }
        let ctx = NoteContext()
        let extracted = extractFootnotes(source.replacingOccurrences(of: "\r\n", with: "\n"))
        ctx.ids = Set(extracted.defs.map(\.id))
        collectFootnoteRefs(extracted.body, notes: ctx)
        let blocks = parseBlocks(extracted.body)
        let parsed = Parsed(blocks: blocks, footnotes: extracted.defs)
        parseCache.setObject(
            CachedParse(parsed: parsed, ids: ctx.ids, order: ctx.order),
            forKey: key
        )
        return (parsed, NoteContext(ids: ctx.ids, order: ctx.order))
    }

    private static func collectFootnoteRefs(_ src: String, notes: NoteContext) {
        for match in src.matches(of: /\[\^([^\]]+)\](?!:)/) {
            _ = notes.number(for: String(match.output.1))
        }
    }

    static func inline(
        _ raw: String,
        fg: Color,
        accent: Color,
        font: Font,
        notes: NoteContext
    ) -> AttributedString {
        var result = AttributedString()
        var i = raw.startIndex

        func appendText(_ s: String) {
            guard !s.isEmpty else { return }
            result.append(plain(s, font: font, color: fg))
        }

        while i < raw.endIndex {
            let rest = raw[i...]

            if rest.hasPrefix("`") {
                let after = raw.index(after: i)
                if after < raw.endIndex, let end = raw[after...].firstIndex(of: "`") {
                    let code = String(raw[after..<end])
                    var run = AttributedString(code)
                    run.font = font.monospaced()
                    run.foregroundColor = fg
                    run.backgroundColor = fg.opacity(0.08)
                    result.append(run)
                    i = raw.index(after: end)
                    continue
                }
            }

            if rest.hasPrefix("***"),
               let end = findClose(raw, from: raw.index(i, offsetBy: 3), mark: "***")
            {
                let inner = String(raw[raw.index(i, offsetBy: 3)..<end])
                result.append(inline(inner, fg: fg, accent: accent, font: font.bold().italic(), notes: notes))
                i = raw.index(end, offsetBy: 3)
                continue
            }

            if rest.hasPrefix("**"),
               let end = findClose(raw, from: raw.index(i, offsetBy: 2), mark: "**")
            {
                let inner = String(raw[raw.index(i, offsetBy: 2)..<end])
                result.append(inline(inner, fg: fg, accent: accent, font: font.weight(.bold), notes: notes))
                i = raw.index(end, offsetBy: 2)
                continue
            }

            if rest.hasPrefix("__"),
               let end = findClose(raw, from: raw.index(i, offsetBy: 2), mark: "__")
            {
                let inner = String(raw[raw.index(i, offsetBy: 2)..<end])
                result.append(inline(inner, fg: fg, accent: accent, font: font.weight(.bold), notes: notes))
                i = raw.index(end, offsetBy: 2)
                continue
            }

            if rest.hasPrefix("~~"),
               let end = findClose(raw, from: raw.index(i, offsetBy: 2), mark: "~~")
            {
                let inner = String(raw[raw.index(i, offsetBy: 2)..<end])
                var run = inline(inner, fg: fg, accent: accent, font: font, notes: notes)
                run.inlinePresentationIntent = .strikethrough
                run.strikethroughStyle = .single
                result.append(run)
                i = raw.index(end, offsetBy: 2)
                continue
            }

            if rest.hasPrefix("*"),
               !rest.hasPrefix("**"),
               let end = findClose(raw, from: raw.index(after: i), mark: "*")
            {
                let inner = String(raw[raw.index(after: i)..<end])
                result.append(inline(inner, fg: fg, accent: accent, font: font.italic(), notes: notes))
                i = raw.index(after: end)
                continue
            }

            if rest.hasPrefix("~"),
               !rest.hasPrefix("~~"),
               let end = findClose(raw, from: raw.index(after: i), mark: "~"),
               end != raw.index(after: i)
            {
                let inner = String(raw[raw.index(after: i)..<end])
                var run = inline(inner, fg: fg, accent: accent, font: .caption2, notes: notes)
                run.baselineOffset = -3
                result.append(run)
                i = raw.index(after: end)
                continue
            }

            if rest.hasPrefix("^"),
               let end = findClose(raw, from: raw.index(after: i), mark: "^"),
               end != raw.index(after: i)
            {
                let inner = String(raw[raw.index(after: i)..<end])
                var run = inline(inner, fg: fg, accent: accent, font: .caption2, notes: notes)
                run.baselineOffset = 6
                result.append(run)
                i = raw.index(after: end)
                continue
            }

            if rest.hasPrefix("[^"),
               let close = raw[raw.index(i, offsetBy: 2)...].firstIndex(of: "]")
            {
                let id = String(raw[raw.index(i, offsetBy: 2)..<close])
                let after = raw.index(after: close)
                if after >= raw.endIndex || raw[after] != "(" {
                    if let num = notes.number(for: id) {
                        var run = AttributedString("\(num)")
                        run.font = .caption2.weight(.semibold)
                        run.foregroundColor = accent
                        run.baselineOffset = 6
                        result.append(run)
                        i = after
                        continue
                    }
                }
            }

            if rest.hasPrefix("["), let link = parseLink(raw, from: i) {
                var run = inline(link.label, fg: accent, accent: accent, font: font, notes: notes)
                run.link = link.url
                run.underlineStyle = .single
                result.append(run)
                i = link.end
                continue
            }

            if rest.hasPrefix("http://") || rest.hasPrefix("https://"),
               let match = rest.firstMatch(of: /^https?:\/\/[^\s<>\]"'`]+/)
            {
                var urlStr = String(match.output)
                while let last = urlStr.last, ".,;:!?".contains(last) {
                    urlStr.removeLast()
                }
                if let url = safeURL(urlStr) {
                    var run = AttributedString(urlStr)
                    run.font = font
                    run.foregroundColor = accent
                    run.link = url
                    run.underlineStyle = .single
                    result.append(run)
                    i = raw.index(i, offsetBy: urlStr.count)
                    continue
                }
            }

            appendText(String(raw[i]))
            i = raw.index(after: i)
        }

        return result
    }

    private static func extractFootnotes(_ src: String) -> (body: String, defs: [(id: String, text: String)]) {
        var defs: [(id: String, text: String)] = []
        var body: [String] = []
        for line in src.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init) {
            if let match = line.firstMatch(of: /^\s*\[\^([^\]]+)\]:\s*(.*)$/) {
                defs.append((String(match.output.1), String(match.output.2)))
            } else {
                body.append(line)
            }
        }
        return (body.joined(separator: "\n"), defs)
    }

    private static func parseBlocks(_ src: String) -> [Block] {
        let lines = src.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map(String.init)
        var blocks: [Block] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]

            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                i += 1
                var body: [String] = []
                while i < lines.count,
                      !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```")
                {
                    body.append(lines[i])
                    i += 1
                }
                if i < lines.count { i += 1 }
                blocks.append(.fence(body.joined(separator: "\n")))
                continue
            }

            if line.firstMatch(of: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/) != nil {
                blocks.append(.hr)
                i += 1
                continue
            }

            if let heading = headingMatch(line) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                i += 1
                continue
            }

            if line.contains("|"),
               i + 1 < lines.count,
               isTableSep(lines[i + 1])
            {
                let headers = splitTableRow(line)
                i += 2
                var rows: [[String]] = []
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(splitTableRow(lines[i]))
                    i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if line.firstMatch(of: /^\s*>/) != nil {
                var quote: [String] = []
                while i < lines.count, lines[i].firstMatch(of: /^\s*>/) != nil {
                    quote.append(lines[i].replacing(/^\s*>\s?/, with: ""))
                    i += 1
                }
                blocks.append(.quote(parseBlocks(quote.joined(separator: "\n"))))
                continue
            }

            if listMatch(line) != nil {
                var rows: [ListItem] = []
                while i < lines.count {
                    if var item = listMatch(lines[i]) {
                        applyTask(&item)
                        rows.append(item)
                        i += 1
                        continue
                    }
                    if !rows.isEmpty,
                       !lines[i].trimmingCharacters(in: .whitespaces).isEmpty,
                       lines[i].firstMatch(of: /^\s{2,}\S/) != nil,
                       listMatch(lines[i]) == nil
                    {
                        rows[rows.count - 1].text +=
                            "\n" + lines[i].trimmingCharacters(in: .whitespaces)
                        i += 1
                        continue
                    }
                    break
                }
                blocks.append(.list(nestList(rows)))
                continue
            }

            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
                continue
            }

            var para = [line]
            i += 1
            while i < lines.count {
                let next = lines[i]
                if next.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                if next.firstMatch(of: /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/) != nil { break }
                if headingMatch(next) != nil { break }
                if listMatch(next) != nil { break }
                if next.firstMatch(of: /^\s*>/) != nil { break }
                if next.contains("|"), i + 1 < lines.count, isTableSep(lines[i + 1]) { break }
                para.append(next)
                i += 1
            }
            blocks.append(.paragraph(para.joined(separator: "\n")))
        }

        return blocks
    }

    private static func applyTask(_ item: inout ListItem) {
        if let match = item.text.firstMatch(of: /^\[([ xX])\]\s+([\s\S]*)$/) {
            item.taskChecked = match.output.1 != " "
            item.text = String(match.output.2)
        }
    }

    private static func headingMatch(_ line: String) -> (level: Int, text: String)? {
        guard let match = line.firstMatch(of: /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/) else {
            return nil
        }
        return (match.output.1.count, String(match.output.2))
    }

    private static func listMatch(_ line: String) -> ListItem? {
        if let match = line.firstMatch(of: /^(\s*)[-*+]\s+(.+)$/) {
            return ListItem(
                text: String(match.output.2),
                children: [],
                ordered: false,
                indent: match.output.1.count,
                start: 1,
                taskChecked: nil
            )
        }
        if let match = line.firstMatch(of: /^(\s*)(\d+)\.\s+(.+)$/) {
            return ListItem(
                text: String(match.output.3),
                children: [],
                ordered: true,
                indent: match.output.1.count,
                start: Int(match.output.2) ?? 1,
                taskChecked: nil
            )
        }
        return nil
    }

    private static func nestList(_ rows: [ListItem]) -> [ListItem] {
        var root: [ListItem] = []
        var path: [Int] = []

        func indent(at indexes: [Int]) -> Int {
            var cur = root
            var value = -1
            for (i, idx) in indexes.enumerated() {
                value = cur[idx].indent
                if i < indexes.count - 1 {
                    cur = cur[idx].children
                }
            }
            return value
        }

        func append(_ item: ListItem, to indexes: [Int]) {
            if indexes.isEmpty {
                root.append(item)
                return
            }
            func rec(_ nodes: inout [ListItem], _ rest: ArraySlice<Int>) {
                guard let first = rest.first else { return }
                if rest.count == 1 {
                    nodes[first].children.append(item)
                } else {
                    rec(&nodes[first].children, rest.dropFirst())
                }
            }
            rec(&root, indexes[...])
        }

        for row in rows {
            while !path.isEmpty, indent(at: path) >= row.indent {
                path.removeLast()
            }
            if path.isEmpty {
                root.append(row)
                path = [root.count - 1]
            } else {
                append(row, to: path)
                func count(at indexes: [Int]) -> Int {
                    var cur = root
                    for (i, idx) in indexes.enumerated() {
                        if i == indexes.count - 1 { return cur[idx].children.count }
                        cur = cur[idx].children
                    }
                    return 0
                }
                path.append(count(at: path) - 1)
            }
        }
        return root
    }

    private static func isTableSep(_ line: String) -> Bool {
        line.firstMatch(of: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/) != nil
    }

    private static func splitTableRow(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.split(separator: "|", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    private static func findClose(_ raw: String, from: String.Index, mark: String) -> String.Index? {
        var i = from
        while i < raw.endIndex {
            if raw[i...].hasPrefix(mark) { return i }
            i = raw.index(after: i)
        }
        return nil
    }

    private static func parseLink(_ raw: String, from: String.Index) -> (label: String, url: URL, end: String.Index)? {
        guard raw[from] == "[" else { return nil }
        guard let closeLabel = raw[raw.index(after: from)...].firstIndex(of: "]") else { return nil }
        let afterLabel = raw.index(after: closeLabel)
        guard afterLabel < raw.endIndex, raw[afterLabel] == "(" else { return nil }
        guard let closeUrl = raw[raw.index(after: afterLabel)...].firstIndex(of: ")") else { return nil }
        let label = String(raw[raw.index(after: from)..<closeLabel])
        var urlRaw = String(raw[raw.index(after: afterLabel)..<closeUrl])
        if let space = urlRaw.firstIndex(of: " ") {
            urlRaw = String(urlRaw[..<space])
        }
        guard let url = safeURL(urlRaw) else { return nil }
        return (label, url, raw.index(after: closeUrl))
    }

    static func safeURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed) else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" || scheme == "mailto" { return url }
        if trimmed.hasPrefix("/"), !trimmed.hasPrefix("//") {
            return URL(string: "https://yanylevin.com\(trimmed)")
        }
        return nil
    }

    static func plain(_ text: String, font: Font, color: Color) -> AttributedString {
        var run = AttributedString(text)
        run.font = font
        run.foregroundColor = color
        return run
    }
}

struct YLMarkdownText: View, Equatable {
    let source: String
    var baseFont: Font = .body
    /// Optional explicit scheme so `.equatable()` still updates on light/dark.
    var scheme: ColorScheme? = nil
    @Environment(\.colorScheme) private var colorScheme

    static func == (lhs: YLMarkdownText, rhs: YLMarkdownText) -> Bool {
        lhs.source == rhs.source && lhs.scheme == rhs.scheme
    }

    var body: some View {
        let parsed = YLMarkdown.parse(source)
        let resolved = scheme ?? colorScheme
        MarkdownBlocksView(
            blocks: parsed.0.blocks,
            footnotes: parsed.0.footnotes,
            notes: parsed.1,
            font: baseFont,
            fg: YLTheme.fg(resolved),
            muted: YLTheme.muted(resolved),
            accent: YLTheme.accent(resolved),
            showFootnotes: true
        )
        .tint(YLTheme.accent(resolved))
    }
}

private struct MarkdownBlocksView: View {
    let blocks: [YLMarkdown.Block]
    var footnotes: [(id: String, text: String)] = []
    let notes: YLMarkdown.NoteContext
    let font: Font
    let fg: Color
    let muted: Color
    let accent: Color
    var spacing: CGFloat = 8
    var showFootnotes: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(
                    block: block,
                    notes: notes,
                    font: font,
                    fg: fg,
                    muted: muted,
                    accent: accent
                )
            }
            if showFootnotes, !notes.order.isEmpty {
                Rectangle()
                    .fill(fg.opacity(0.18))
                    .frame(height: 1)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(notes.order.enumerated()), id: \.offset) { idx, id in
                        let body = footnotes.first(where: { $0.id == id })?.text ?? ""
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text("\(idx + 1).")
                                .font(.caption)
                                .foregroundStyle(muted)
                            Text(
                                YLMarkdown.inline(
                                    body,
                                    fg: muted,
                                    accent: accent,
                                    font: .caption,
                                    notes: notes
                                )
                            )
                        }
                    }
                }
            }
        }
        .frame(minWidth: 0, alignment: .leading)
    }
}

private struct MarkdownBlockView: View {
    let block: YLMarkdown.Block
    let notes: YLMarkdown.NoteContext
    let font: Font
    let fg: Color
    let muted: Color
    let accent: Color

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(inline(text, font: font, color: fg))
        case .heading(let level, let text):
            Text(inline(text, font: headingFont(level), color: fg))
        case .list(let items):
            MarkdownListView(
                items: items,
                notes: notes,
                font: font,
                fg: fg,
                muted: muted,
                accent: accent,
                depth: 0
            )
        case .fence(let code):
            Text(code.isEmpty ? " " : code)
                .font(font.monospaced())
                .foregroundStyle(muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(fg.opacity(0.07))
                }
        case .quote(let nested):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(muted.opacity(0.45))
                    .frame(width: 2)
                MarkdownBlocksView(
                    blocks: nested,
                    notes: notes,
                    font: font,
                    fg: muted,
                    muted: muted,
                    accent: accent,
                    spacing: 6,
                    showFootnotes: false
                )
            }
        case .table(let headers, let rows):
            MarkdownTableView(
                headers: headers,
                rows: rows,
                notes: notes,
                font: font,
                fg: fg,
                accent: accent
            )
        case .hr:
            Rectangle()
                .fill(muted.opacity(0.28))
                .frame(height: 1)
                .padding(.vertical, 2)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.weight(.bold)
        case 2: return .headline
        default: return font.weight(.bold)
        }
    }

    private func inline(_ text: String, font: Font, color: Color) -> AttributedString {
        YLMarkdown.inline(text, fg: color, accent: accent, font: font, notes: notes)
    }
}

private struct MarkdownListView: View {
    let items: [YLMarkdown.ListItem]
    let notes: YLMarkdown.NoteContext
    let font: Font
    let fg: Color
    let muted: Color
    let accent: Color
    let depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    marker(item, idx)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(
                            YLMarkdown.inline(
                                item.text,
                                fg: fg,
                                accent: accent,
                                font: font,
                                notes: notes
                            )
                        )
                        if !item.children.isEmpty {
                            MarkdownListView(
                                items: item.children,
                                notes: notes,
                                font: font,
                                fg: fg,
                                muted: muted,
                                accent: accent,
                                depth: depth + 1
                            )
                        }
                    }
                }
            }
        }
        .padding(.leading, depth == 0 ? 0 : 12)
    }

    @ViewBuilder
    private func marker(_ item: YLMarkdown.ListItem, _ idx: Int) -> some View {
        if let checked = item.taskChecked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(font)
                .foregroundStyle(checked ? accent : muted)
                .accessibilityLabel(checked ? "Checked" : "Unchecked")
        } else if item.ordered {
            let n = (items.first?.start ?? 1) + idx
            Text("\(n).")
                .font(font)
                .foregroundStyle(fg)
                .monospacedDigit()
        } else {
            Text("•")
                .font(font)
                .foregroundStyle(fg)
        }
    }
}

private struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    let notes: YLMarkdown.NoteContext
    let font: Font
    let fg: Color
    let accent: Color

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                    cell(header, header: true)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(0..<headers.count, id: \.self) { col in
                        cell(col < row.count ? row[col] : "", header: false)
                    }
                }
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(fg.opacity(0.18), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func cell(_ text: String, header: Bool) -> some View {
        Text(
            YLMarkdown.inline(
                text,
                fg: fg,
                accent: accent,
                font: header ? font.weight(.semibold) : font,
                notes: notes
            )
        )
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .trailing) {
            Rectangle().fill(fg.opacity(0.12)).frame(width: 1)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(fg.opacity(header ? 0.18 : 0.1)).frame(height: 1)
        }
    }
}
