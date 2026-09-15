import Foundation

extension APIClient {
    static func makeURL(path: String, query: [URLQueryItem] = []) -> URL? {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let root = APIConfig.usesMacAPI(trimmed) ? APIConfig.apiBaseURL : APIConfig.siteBaseURL
        guard var components = URLComponents(url: root, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let encodedRel = trimmed.split(separator: "/", omittingEmptySubsequences: false).map { part in
            String(part).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String(part)
        }.joined(separator: "/")
        let basePath = components.path.hasSuffix("/")
            ? String(components.path.dropLast())
            : components.path
        components.percentEncodedPath = "\(basePath)/\(encodedRel)"
        if !query.isEmpty {
            components.queryItems = query
        }
        return components.url
    }
}
