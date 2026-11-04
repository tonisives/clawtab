import ExpoModulesCore
import Foundation

public class ClawTabIapDiagnosticsModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ClawTabIapDiagnostics")
        AsyncFunction("read") { () -> String in
            IapDiagnosticsReader.read()
        }
    }
}
