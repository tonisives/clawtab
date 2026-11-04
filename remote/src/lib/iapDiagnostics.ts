import { requireOptionalNativeModule } from "expo"
import Constants from "expo-constants"
import { Platform } from "react-native"

type NativeDiagnostics = { read: () => Promise<string> }
export async function readIapDiagnostics(): Promise<string> {
  let header = `Build: ${Constants.nativeAppVersion ?? "unknown"} (${Constants.nativeBuildVersion ?? "unknown"})\nOS: ${Platform.OS} ${Platform.Version}`
  let native = requireOptionalNativeModule<NativeDiagnostics>("ClawTabIapDiagnostics")
  return `${header}\nNative stages:\n${native ? await native.read() : "Requires an updated iOS build"}`
}
