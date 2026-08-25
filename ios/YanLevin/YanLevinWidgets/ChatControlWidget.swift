import AppIntents
import SwiftUI
import WidgetKit

struct ChatControlWidget: ControlWidget {
    /// Kind bumped with the OpenIntent switch so iOS drops the old AppIntent control.
    static let kind = "com.example.personalagent.chatControl.v4"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenChatIntent(target: .newChat)) {
                Label {
                    Text("Chat")
                } icon: {
                    Image("YLMark")
                }
            }
        }
        .displayName("Chat")
        .description("Starts a new chat. Unlock the phone first.")
    }
}
