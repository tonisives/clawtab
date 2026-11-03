import { Image, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { jobKindIconSources } from "../../../shared/src/components/JobKindIcon";

export const appIcon = require("../../assets/icon.png");

let preload: Promise<void> | undefined;

export function preloadAppIcons() {
  return preload ??= (async () => {
    const tasks = [Ionicons.loadFont()];
    if (Platform.OS !== "web") {
      for (const source of [appIcon, ...jobKindIconSources]) {
        const { uri } = Image.resolveAssetSource(source)!;
        tasks.push(Image.prefetch(uri).then((loaded) => {
          if (!loaded) throw new Error("Icon prefetch failed");
        }));
      }
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") console.warn("Could not preload app icon", result.reason);
    }
  })();
}
