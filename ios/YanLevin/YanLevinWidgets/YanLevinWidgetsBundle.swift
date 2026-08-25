import WidgetKit
import SwiftUI

@main
struct YanLevinWidgets: WidgetBundle {
    var body: some Widget {
        ScheduleWidget()
        TodoWidget()
        ChatControlWidget()
    }
}
