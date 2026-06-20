import { StyleSheet, View } from "react-native";
import { Stack, useRouter } from "expo-router";

import { colors } from "../src/theme/colors";
import { NotificationsPanel } from "../src/components/NotificationsPanel";
import { HeaderBackButton } from "../src/components/HeaderButtons";

export default function NotificationsScreen() {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Notifications",
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: styles.headerTitle,
          headerShadowVisible: true,
          headerLeft: () => <HeaderBackButton onPress={goBack} />,
        }}
      />
      <NotificationsPanel mode="screen" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "600",
  },
});
