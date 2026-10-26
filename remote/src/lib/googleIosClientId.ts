import app from "../../app.json";

// Use the same public OAuth client that Expo registers in the native URL schemes.
const plugin = app.expo.plugins.find(
  (entry) => Array.isArray(entry) && entry[0] === "@react-native-google-signin/google-signin",
) as [string, { iosUrlScheme: string }];

export const googleIosClientId = plugin[1].iosUrlScheme.split(".").reverse().join(".");
