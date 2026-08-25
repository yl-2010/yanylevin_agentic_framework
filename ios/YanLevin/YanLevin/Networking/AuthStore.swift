import Foundation
import AuthenticationServices
import SwiftUI
import UIKit
#if canImport(GoogleSignIn)
import GoogleSignIn
#endif

struct AuthSession: Equatable {
    var email: String
    var name: String
    var access: String // "full" | "denied"
    var token: String

    var isFull: Bool { access == "full" }
}

@MainActor
final class AuthStore: ObservableObject {
    static let shared = AuthStore()

    @Published private(set) var session: AuthSession?
    @Published var isBusy = false
    @Published var lastError: String?

    var isAuthenticated: Bool { session != nil }
    var hasFullAccess: Bool { session?.isFull == true }

    private var webAuthSession: ASWebAuthenticationSession?

    private init() {
        // App Group is readable while locked; Keychain is AfterFirstUnlock.
        // Hydrate immediately so lock-screen Chat does not flash the guest Home tab.
        hydrateFromAppGroupIfNeeded()
        Task {
            let token = await Task.detached {
                KeychainStore.loadToken()
            }.value
            let resolved = token ?? AppGroupStore.token
            guard let resolved, !resolved.isEmpty else { return }
            await restore(token: resolved)
        }
    }

    /// Last signed-in full-access session, without waiting on Keychain or `/session`.
    private func hydrateFromAppGroupIfNeeded() {
        guard session == nil else { return }
        guard AppGroupStore.hasFullAccess, let token = AppGroupStore.token else { return }
        let email = AppGroupStore.email ?? ""
        guard !email.isEmpty else { return }
        session = AuthSession(
            email: email,
            name: AppGroupStore.name ?? email,
            access: "full",
            token: token
        )
        attachPersonalSensors(email: email, token: token, fullAccess: true)
    }

    func handleOpenURL(_ url: URL) {
        #if canImport(GoogleSignIn)
        GIDSignIn.sharedInstance.handle(url)
        #endif
        if url.scheme == "yanylevin", url.host == "oauth" {
            applyMobileOAuthCallback(url)
        }
    }

    func restore(token: String) async {
        do {
            let res: SessionResponse = try await APIClient.shared.request(
                "api/auth/session",
                bearer: token
            )
            if res.authenticated, let email = res.email, let access = res.access {
        session = AuthSession(
                    email: email,
                    name: res.name ?? email,
                    access: access,
                    token: token
                )
                KeychainStore.saveToken(token)
                AppGroupStore.saveSession(
                    token: token,
                    email: email,
                    name: res.name ?? email,
                    access: access
                )
                attachPersonalSensors(
                    email: email,
                    token: token,
                    fullAccess: access == "full"
                )
            } else {
                signOutLocal()
            }
        } catch {
            if case APIError.unauthorized = error {
                signOutLocal()
            }
        }
    }

    func signInWithApple(credential: ASAuthorizationAppleIDCredential) async {
        guard let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8) else {
            lastError = "Apple Sign In failed (missing identity token)."
            return
        }
        let name = [credential.fullName?.givenName, credential.fullName?.familyName]
            .compactMap { $0 }
            .joined(separator: " ")
        await exchange(provider: "apple", idToken: idToken, name: name.isEmpty ? nil : name)
    }

    /// Google sign-in via the site’s existing web OAuth (works without a separate iOS client ID).
    func signInWithGoogle(presenting viewController: UIViewController) async {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            isBusy = true
        }
        lastError = nil
        defer {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                isBusy = false
            }
        }

        let startURL = APIConfig.siteBaseURL.appending(path: "api/auth/google")
        var comps = URLComponents(url: startURL, resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "mobile", value: "1")]
        guard let authURL = comps?.url else {
            lastError = "Could not start Google Sign-In."
            return
        }

        do {
            let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
                let session = ASWebAuthenticationSession(
                    url: authURL,
                    callbackURLScheme: "yanylevin"
                ) { url, error in
                    if let error {
                        continuation.resume(throwing: error)
                        return
                    }
                    guard let url else {
                        continuation.resume(throwing: URLError(.badURL))
                        return
                    }
                    continuation.resume(returning: url)
                }
                session.presentationContextProvider = WebAuthPresenter.shared
                session.prefersEphemeralWebBrowserSession = false
                self.webAuthSession = session
                if !session.start() {
                    continuation.resume(throwing: URLError(.badURL))
                }
            }
            applyMobileOAuthCallback(callbackURL)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // User cancelled — keep quiet.
        } catch {
            // Fall back to native Google SDK if an iOS client ID is configured.
            #if canImport(GoogleSignIn)
            await signInWithGoogleSDK(presenting: viewController)
            if lastError == nil { lastError = error.localizedDescription }
            #else
            lastError = error.localizedDescription
            #endif
        }
    }

    #if canImport(GoogleSignIn)
    private func signInWithGoogleSDK(presenting viewController: UIViewController) async {
        let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String ?? ""
        guard !clientID.isEmpty, !clientID.contains("PLACEHOLDER"), clientID.contains(".") else {
            return
        }
        do {
            let config = GIDConfiguration(clientID: clientID)
            GIDSignIn.sharedInstance.configuration = config
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: viewController)
            guard let idToken = result.user.idToken?.tokenString else {
                lastError = "Google Sign In failed (missing ID token)."
                return
            }
            await exchange(provider: "google", idToken: idToken, name: result.user.profile?.name)
        } catch {
            lastError = error.localizedDescription
        }
    }
    #endif

    private func applyMobileOAuthCallback(_ url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let dict = Dictionary(uniqueKeysWithValues: items.compactMap { item -> (String, String)? in
            guard let value = item.value else { return nil }
            return (item.name, value)
        })
        if let error = dict["error"], !error.isEmpty {
            lastError = "Google Sign-In failed (\(error))."
            return
        }
        guard let token = dict["token"], let email = dict["email"], let access = dict["access"] else {
            lastError = "Google Sign-In failed (incomplete response)."
            return
        }
        let name = dict["name"] ?? email
        session = AuthSession(email: email, name: name, access: access, token: token)
        KeychainStore.saveToken(token)
        AppGroupStore.saveSession(token: token, email: email, name: name, access: access)
        attachPersonalSensors(
            email: email,
            token: token,
            fullAccess: access == "full"
        )
        lastError = nil
    }

    private func exchange(provider: String, idToken: String, name: String?) async {
        withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
            isBusy = true
        }
        lastError = nil
        defer {
            withAnimation(.spring(response: 0.38, dampingFraction: 0.86)) {
                isBusy = false
            }
        }
        do {
            let body = MobileAuthRequest(provider: provider, idToken: idToken, name: name)
            let res: MobileAuthResponse = try await APIClient.shared.request(
                "api/auth/mobile",
                method: "POST",
                body: body
            )
            guard let token = res.token, let email = res.email, let access = res.access else {
                lastError = res.error ?? "Sign in failed."
                return
            }
            let session = AuthSession(
                email: email,
                name: res.name ?? name ?? email,
                access: access,
                token: token
            )
            self.session = session
            KeychainStore.saveToken(token)
            AppGroupStore.saveSession(
                token: token,
                email: email,
                name: session.name,
                access: access
            )
            attachPersonalSensors(
                email: email,
                token: token,
                fullAccess: access == "full"
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    func signOut() async {
        if let token = session?.token {
            _ = try? await APIClient.shared.requestRaw(
                "api/auth/signout",
                method: "POST",
                bearer: token
            )
        }
        #if canImport(GoogleSignIn)
        GIDSignIn.sharedInstance.signOut()
        #endif
        signOutLocal()
    }

    func deleteAccount() async {
        guard let token = session?.token else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let _: DeleteResponse = try await APIClient.shared.request(
                "api/auth/delete-account",
                method: "POST",
                bearer: token
            )
            await signOut()
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func attachPersonalSensors(email: String?, token: String?, fullAccess: Bool) {
        PhoneLocationReporter.shared.attach(email: email, token: token, fullAccess: fullAccess)
    }

    private func signOutLocal() {
        attachPersonalSensors(email: nil, token: nil, fullAccess: false)
        session = nil
        KeychainStore.clearToken()
        AppGroupStore.clearSession()
    }
}

private final class WebAuthPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthPresenter()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

struct MobileAuthRequest: Encodable {
    let provider: String
    let idToken: String
    let name: String?
}

struct MobileAuthResponse: Decodable {
    let ok: Bool?
    let token: String?
    let email: String?
    let name: String?
    let access: String?
    let error: String?
}

struct SessionResponse: Decodable {
    let ok: Bool?
    let authenticated: Bool
    let email: String?
    let name: String?
    let access: String?
}

struct DeleteResponse: Decodable {
    let ok: Bool?
    let error: String?
}
