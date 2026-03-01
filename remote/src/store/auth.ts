import { create } from "zustand"
import * as api from "../api/client"
import { clearCache } from "../lib/jobCache"

interface AuthState {
  isAuthenticated: boolean
  userId: string | null
  loading: boolean

  init: () => Promise<void>
  login: (email: string, password: string, serverUrl?: string) => Promise<void>
  register: (
    email: string,
    password: string,
    displayName?: string,
    serverUrl?: string,
  ) => Promise<void>
  googleLogin: (idToken: string) => Promise<void>
  logout: () => Promise<void>
  refreshToken: () => Promise<boolean>
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  userId: null,
  loading: true,

  init: async () => {
    try {
      const { accessToken, userId } = await api.getStoredTokens()
      if (accessToken && userId) {
        set({ isAuthenticated: true, userId, loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  login: async (email, password, serverUrl) => {
    const resp = await api.login(email, password, serverUrl)
    set({ isAuthenticated: true, userId: resp.user_id })
  },

  register: async (email, password, displayName, serverUrl) => {
    const resp = await api.register(email, password, displayName, serverUrl)
    set({ isAuthenticated: true, userId: resp.user_id })
  },

  googleLogin: async (idToken) => {
    const resp = await api.googleAuth(idToken)
    set({ isAuthenticated: true, userId: resp.user_id })
  },

  logout: async () => {
    await api.clearTokens()
    await clearCache()
    set({ isAuthenticated: false, userId: null })
  },

  refreshToken: async () => {
    try {
      await api.refreshToken()
      return true
    } catch {
      set({ isAuthenticated: false, userId: null })
      return false
    }
  },
}))
