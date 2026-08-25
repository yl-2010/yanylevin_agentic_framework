import Foundation

extension APIClient {
    static func makeURL(path: String, query: [URLQueryItem] = []) -> URL? {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let root = APIConfig.usesMacAPI(trimmed) ? APIConfig.apiBaseURL : APIConfig.siteBaseURL
        let base = root.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var components = URLComponents(string: "\(base)/\(trimmed)") else {
            return nil
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        return components.url
    }
}
