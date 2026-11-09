import { clearMessageShellCache } from "../lib/cacheMessageShell";
import { trackRemoteEvent } from "../lib/analytics";
import { terminalCache } from "../lib/terminalCache";
import { create } from "zustand"
import * as api from "../api/client"
import { clearCache } from "../lib/jobCache"

interface AuthState {
  isAuthenticated: boolean
  userId: string | null
  email: string | null
  loading: boolean

  init: () => Promise<void>
  googleLogin: (idToken: string) => Promise<void>
  passwordLogin: (email: string, password: string) => Promise<void>
  appleLogin: (idToken: string, displayName?: string, email?: string) => Promise<void>
  setAuth: (userId: string, accessToken: string) => void
  logout: () => Promise<void>
  refreshToken: () => Promise<boolean>
}

function emailFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]))
    return payload.email ?? null
  } catch {
    return null
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  userId: null,
  email: null,
  loading: true,

  init: async () => {
    try {
      let { accessToken, userId } = await api.getStoredTokens()
      if (accessToken && userId) {
        if (api.isTokenExpiringSoon(accessToken)) {
          try {
            let refreshed = await api.refreshToken()
            accessToken = refreshed.access_token
          } catch (error) {
            if (!api.isInvalidRefreshError(error)) {
              set({ isAuthenticated: true, userId, email: emailFromToken(accessToken), loading: false })
              return
            }
            const current = await api.getStoredTokens()
            if (current.accessToken && current.userId && (current.accessToken !== accessToken || current.userId !== userId)) {
              await get().init()
              return
            }
            await api.clearTokens()
            await clearCache(userId)
            terminalCache.clear(); clearMessageShellCache()
            set({ isAuthenticated: false, userId: null, email: null, loading: false })
            return
          }
        }
        set({ isAuthenticated: true, userId, email: emailFromToken(accessToken), loading: false })
      } else {
        const previousUser = get().userId
        set({ isAuthenticated: false, userId: null, email: null, loading: false })
        await clearCache(previousUser)
        terminalCache.clear(); clearMessageShellCache()
      }
    } catch {
      set({ loading: false })
    }
  },

  googleLogin: async (idToken) => {
    await clearCache(get().userId)
    terminalCache.clear(); clearMessageShellCache()
    const resp = await api.googleAuth(idToken)
    trackRemoteEvent("login")
    set({ isAuthenticated: true, userId: resp.user_id, email: emailFromToken(resp.access_token) })
  },

  passwordLogin: async (email, password) => {
    const resp = await api.passwordLogin(email, password)
    await clearCache(get().userId)
    terminalCache.clear(); clearMessageShellCache()
    trackRemoteEvent("login")
    set({ isAuthenticated: true, userId: resp.user_id, email: emailFromToken(resp.access_token) })
  },

  appleLogin: async (idToken, displayName, email) => {
    await clearCache(get().userId)
    terminalCache.clear(); clearMessageShellCache()
    const resp = await api.appleAuth(idToken, displayName, email)
    trackRemoteEvent("login")
    set({ isAuthenticated: true, userId: resp.user_id, email: emailFromToken(resp.access_token) })
  },

  setAuth: (userId, accessToken) => {
    trackRemoteEvent("login")
    clearCache(get().userId)
    terminalCache.clear(); clearMessageShellCache()
    set({ isAuthenticated: true, userId, email: emailFromToken(accessToken) })
  },

  logout: async () => {
    await api.clearTokens()
    await clearCache(get().userId)
    terminalCache.clear(); clearMessageShellCache()
    set({ isAuthenticated: false, userId: null, email: null })
  },

  refreshToken: async () => {
    try {
      await api.refreshToken()
      return true
    } catch {
      // The API expires rejected credentials and preserves newer account sessions.
      return false
    }
  },
}))


api.onSessionExpired((userId) => {
  if (useAuthStore.getState().userId !== userId) return;
  useAuthStore.setState({ isAuthenticated: false, userId: null, email: null, loading: false });
  void clearCache(userId);
  terminalCache.clear(); clearMessageShellCache();
});
