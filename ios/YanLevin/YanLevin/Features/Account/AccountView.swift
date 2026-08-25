import SwiftUI
import AuthenticationServices
import UIKit

struct AccountView: View {
    /// Flip to `true` after re-adding `com.apple.developer.applesignin` under a paid Apple Developer team.
    static let signInWithAppleEnabled = false

    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var theme: ThemeStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var confirmDelete = false

    private var isPadLayout: Bool {
        AdaptiveLayout.isRegularWidth(horizontalSizeClass)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    statusCard
                    if !auth.isAuthenticated {
                        signInCard
                    }
                    themeCard
                    if auth.isAuthenticated {
                        signedInCard
                    }
                    linksCard
                }
                .padding(isPadLayout ? 28 : 16)
                .adaptiveReadableWidth(AdaptiveLayout.formMaxWidth)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .tabReselectScrollToTop(for: .account)
            .ylPageBackground()
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.large)
            .alert("Delete account data?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) {
                    Task { await auth.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Removes your session and login/chat log entries for your email.")
            }
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let session = auth.session {
                Text(session.email)
                    .font(.headline)
                    .foregroundStyle(YLTheme.fg)
                if !session.name.isEmpty, session.name != session.email {
                    Text(session.name)
                        .foregroundStyle(YLTheme.muted)
                }
            } else {
                Text("Not signed in")
                    .font(.headline)
                    .foregroundStyle(YLTheme.fg)
            }
            if let err = auth.lastError {
                Text(err).font(.footnote).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .ylGlassRounded(cornerRadius: 18, interactive: true)
    }

    private var signInCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            if Self.signInWithAppleEnabled {
                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = [.fullName, .email]
                } onCompletion: { result in
                    switch result {
                    case .success(let authResult):
                        if let cred = authResult.credential as? ASAuthorizationAppleIDCredential {
                            Task { await auth.signInWithApple(credential: cred) }
                        }
                    case .failure(let error):
                        auth.lastError = error.localizedDescription
                    }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 48)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }

            Button {
                guard let vc = topViewController() else {
                    auth.lastError = "Could not present Google Sign-In."
                    return
                }
                Task { await auth.signInWithGoogle(presenting: vc) }
            } label: {
                Label("Sign in with Google", systemImage: "g.circle.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .ylGlassButton()
            .disabled(auth.isBusy)
            .opacity(auth.isBusy ? 0.55 : 1)

            if auth.isBusy {
                HStack(alignment: .center, spacing: 8) {
                    Text("Signing in")
                        .font(.subheadline.weight(.medium))
                    YLBusyDots()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .foregroundStyle(YLTheme.muted)
                .ylGlassRounded(cornerRadius: 14, interactive: true)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Signing in")
                .transition(
                    .asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)),
                        removal: .opacity
                    )
                )
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.86), value: auth.isBusy)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .ylGlassRounded(cornerRadius: 18, interactive: true)
    }

    private var signedInCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Sign out") {
                Task { await auth.signOut() }
            }
            .ylGlassButton()

            Button("Delete account data…", role: .destructive) {
                confirmDelete = true
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .ylGlassRounded(cornerRadius: 18, interactive: true)
    }

    private var themeCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Appearance")
                .font(.headline)
            Picker("Theme", selection: $theme.preference) {
                ForEach(ThemePreference.allCases) { pref in
                    Text(pref.title).tag(pref)
                }
            }
            .pickerStyle(.segmented)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .ylGlassRounded(cornerRadius: 18, interactive: true)
    }

    private var linksCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Link("Privacy Policy", destination: APIConfig.privacyURL)
            Link("Website", destination: APIConfig.siteBaseURL)
        }
        .font(.body.weight(.medium))
        .foregroundStyle(YLTheme.accent)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .ylGlassRounded(cornerRadius: 18, interactive: true)
    }
}

private func topViewController(base: UIViewController? = nil) -> UIViewController? {
    let base = base ?? UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first { $0.isKeyWindow }?
        .rootViewController
    if let nav = base as? UINavigationController { return topViewController(base: nav.visibleViewController) }
    if let tab = base as? UITabBarController { return topViewController(base: tab.selectedViewController) }
    if let presented = base?.presentedViewController { return topViewController(base: presented) }
    return base
}
