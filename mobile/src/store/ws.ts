import { create } from "zustand";

interface WsState {
  connected: boolean;
  subscriptionRequired: boolean;
  desktopOnline: boolean;
  desktopDeviceId: string | null;
  desktopDeviceName: string | null;

  setConnected: (v: boolean) => void;
  setSubscriptionRequired: (v: boolean) => void;
  setDesktopStatus: (
    deviceId: string,
    deviceName: string,
    online: boolean,
  ) => void;
  reset: () => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  subscriptionRequired: false,
  desktopOnline: false,
  desktopDeviceId: null,
  desktopDeviceName: null,

  setConnected: (connected) => set({ connected }),
  setSubscriptionRequired: (subscriptionRequired) => set({ subscriptionRequired }),

  setDesktopStatus: (deviceId, deviceName, online) =>
    set({
      desktopOnline: online,
      desktopDeviceId: deviceId,
      desktopDeviceName: deviceName,
    }),

  reset: () =>
    set({
      connected: false,
      subscriptionRequired: false,
      desktopOnline: false,
      desktopDeviceId: null,
      desktopDeviceName: null,
    }),
}));
