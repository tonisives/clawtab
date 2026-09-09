import { ScrollView, Platform, Linking } from "react-native";
import { MachinesPanel, RentalsPanel } from "@clawtab/shared";
import { approveMachinePairing, machineApi, rentalApi } from "../../src/api/client";
let DevicesScreen = () => (
  <ScrollView>
    <RentalsPanel api={rentalApi} purchases={Platform.OS === "web"} openUrl={Linking.openURL} />
    <MachinesPanel approvePairing={approveMachinePairing} api={machineApi} />
  </ScrollView>
);
export default DevicesScreen;
