import Foundation

enum WidgetEducationLoader {
    static func loadTree() async -> EducationTreeResponse? {
        guard AppGroupStore.hasFullAccess, let token = AppGroupStore.token else {
            return nil
        }
        do {
            let (data, http) = try await APIClient.shared.requestRaw(
                "api/education/data",
                bearer: token
            )
            guard (200..<300).contains(http.statusCode) else {
                return AppGroupStore.loadCachedEducationTree()
            }
            AppGroupStore.cacheEducationData(data, reloadWidgets: false)
            return try JSONDecoder().decode(EducationTreeResponse.self, from: data)
        } catch {
            return AppGroupStore.loadCachedEducationTree()
        }
    }
}
