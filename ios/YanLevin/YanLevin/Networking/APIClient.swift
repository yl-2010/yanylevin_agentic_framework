import Foundation

enum APIConfig {
    static var siteBaseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "YanSiteBaseURL") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://yanylevin.com")!
    }

    /// Mac Express via Cloudflare Tunnel (education/fitness data + SSE + agent).
    static var apiBaseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "YanApiBaseURL") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://api.yanylevin.com")!
    }

    static let privacyURL = URL(string: "https://yanylevin.com/privacy/")!
    static let linkedinURL = URL(string: "https://github.com/yl-2010/yanylevin_agentic_framework")!
    static let githubURL = URL(string: "https://github.com/yl-2010")!
    static let mailURL = URL(string: "mailto:you@example.com")!

    /// Auth stays on Vercel; education/fitness hit the Mac API directly.
    static func usesMacAPI(_ path: String) -> Bool {
        let p = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return p.hasPrefix("api/education/") || p.hasPrefix("api/fitness/")
    }
}

enum APIError: LocalizedError {
    case http(Int, String)
    case decoding
    case offline(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .http(let code, let msg): return "HTTP \(code): \(msg)"
        case .decoding: return "Could not read server response."
        case .offline(let msg): return msg
        case .unauthorized: return "Please sign in again."
        }
    }
}

struct APIClient {
    static let shared = APIClient()
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 120
        c.timeoutIntervalForResource = 300
        return URLSession(configuration: c)
    }()

    func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil,
        bearer: String? = nil,
        query: [URLQueryItem] = []
    ) async throws -> T {
        guard let url = Self.makeURL(path: path, query: query) else { throw APIError.offline("Bad URL") }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer, !bearer.isEmpty {
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(AnyEncodable(body))
        }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.offline("Yan’s Mac is offline or unreachable. Try again later.")
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.decoding }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if !(200..<300).contains(http.statusCode) {
            let msg = String(data: data, encoding: .utf8) ?? ""
            if http.statusCode >= 500 {
                throw APIError.offline("Yan’s Mac is offline or the API failed. (\(http.statusCode))")
            }
            throw APIError.http(http.statusCode, msg.prefix(240).description)
        }
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    func requestRaw(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil,
        bearer: String? = nil,
        query: [URLQueryItem] = []
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = Self.makeURL(path: path, query: query) else { throw APIError.offline("Bad URL") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearer, !bearer.isEmpty {
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(AnyEncodable(body))
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.decoding }
        return (data, http)
    }
}

private struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void
    init(_ value: any Encodable) {
        encodeFunc = { encoder in try value.encode(to: encoder) }
    }
    func encode(to encoder: Encoder) throws { try encodeFunc(encoder) }
}
