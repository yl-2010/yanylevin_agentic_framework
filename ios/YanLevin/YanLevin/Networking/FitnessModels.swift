import Foundation

struct FitnessTreeResponse: Decodable {
    let ok: Bool?
    let email: String?
    let todayKey: String?
    let timezone: String?
    let meta: FitnessMeta?
    let machines: [FitnessMachine]?
    let error: String?
}

struct FitnessMeta: Decodable {
    let displayName: String?
    let timezone: String?
}

struct FitnessMachine: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let order: Int?
    /// `#rrggbb` from machine.json — unique per user when set by the fitness agent.
    let color: String?
    let allTimeMax: Double?
    let recent: [FitnessRecentBox?]?
    let graph: [FitnessGraphPoint]?
    let sessionMin: Double?
    let lastSessionDate: String?
    let pending: [FitnessPendingEntry]?
    let entryCount: Int?
    let historyCount: Int?
    let history: [FitnessGraphPoint]?

    var displayName: String { name ?? id }
}

struct FitnessRecentBox: Decodable, Hashable {
    let id: String?
    let weight: Double?
    let at: String?
    let dateKey: String?
    let fromLastSession: Bool?
    let tone: String?
}

struct FitnessGraphPoint: Decodable, Hashable, Identifiable {
    let id: String
    let weight: Double?
    let at: String?
    let dateKey: String?
}

struct FitnessPendingEntry: Decodable, Hashable, Identifiable {
    let id: String
    let weight: Double?
    let at: String?
    let dateKey: String?
}

struct FitnessEntriesBody: Encodable {
    let machineId: String
    let weights: [Double]
}

struct FitnessEntriesResponse: Decodable {
    let ok: Bool?
    let machineId: String?
    let created: [FitnessPendingEntry]?
    let tree: FitnessTreeResponse?
    let error: String?
}

struct FitnessAgentStartResponse: Decodable {
    let ok: Bool?
    let sessionId: String?
    let error: String?
}

struct FitnessAgentMessageBody: Encodable {
    let sessionId: String
    let message: String
    let machineId: String?
    let machineName: String?
}

struct FitnessAgentMessageResponse: Decodable {
    let ok: Bool?
    let reply: String?
    let error: String?
}

struct FitnessAgentStopBody: Encodable {
    let sessionId: String
}
