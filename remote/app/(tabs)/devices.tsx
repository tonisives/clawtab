import { View } from "react-native";
import { MachinesPanel } from "@clawtab/shared";
import { approveMachinePairing, machineApi } from "../../src/api/client";
export default function DevicesScreen() { return <View><MachinesPanel approvePairing={approveMachinePairing} api={machineApi} /></View>; }
