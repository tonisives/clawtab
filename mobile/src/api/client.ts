import * as storage from "../lib/storage";

const KEYS = {
  accessToken: "clawtab_access_token",
  refreshToken: "clawtab_refresh_token",
  serverUrl: "clawtab_server_url",
  userId: "clawtab_user_id",
};

const DEFAULT_SERVER = "https://relay.clawtab.cc";
const DEFAULT_BACKEND = "https://backend.clawtab.cc";

export interface AuthResponse {
  user_id: string;
  access_token: string;
  refresh_token: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  last_seen: string | null;
  created_at: string;
  is_online: boolean;
}

async function getServerUrl(): Promise<string> {
  return (await storage.getItem(KEYS.serverUrl)) || DEFAULT_SERVER;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  useAuth = false,
): Promise<T> {
  const serverUrl = await getServerUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (useAuth) {
    const token = await storage.getItem(KEYS.accessToken);
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  let resp = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers,
  });

  // Auto-refresh on 401 for authenticated requests
  if (resp.status === 401 && useAuth) {
    try {
      await refreshToken();
      const newToken = await storage.getItem(KEYS.accessToken);
      if (newToken) {
        headers["Authorization"] = `Bearer ${newToken}`;
        resp = await fetch(`${serverUrl}${path}`, { ...options, headers });
      }
    } catch {
      // refresh failed, throw the original 401
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `HTTP ${resp.status}`);
  }

  return resp.json();
}

async function backendRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const serverUrl = await getServerUrl();
  const backendUrl = serverUrl === DEFAULT_SERVER ? DEFAULT_BACKEND : serverUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const token = await storage.getItem(KEYS.accessToken);
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let resp = await fetch(`${backendUrl}${path}`, {
    ...options,
    headers,
  });

  if (resp.status === 401) {
    try {
      await refreshToken();
      const newToken = await storage.getItem(KEYS.accessToken);
      if (newToken) {
        headers["Authorization"] = `Bearer ${newToken}`;
        resp = await fetch(`${backendUrl}${path}`, { ...options, headers });
      }
    } catch {
      // refresh failed
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(text || `HTTP ${resp.status}`);
  }

  return resp.json();
}

export async function login(
  email: string,
  password: string,
  serverUrl?: string,
): Promise<AuthResponse> {
  if (serverUrl) {
    await storage.setItem(KEYS.serverUrl, serverUrl);
  }

  const resp = await request<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  await storage.setItem(KEYS.accessToken, resp.access_token);
  await storage.setItem(KEYS.refreshToken, resp.refresh_token);
  await storage.setItem(KEYS.userId, resp.user_id);

  return resp;
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
  serverUrl?: string,
): Promise<AuthResponse> {
  if (serverUrl) {
    await storage.setItem(KEYS.serverUrl, serverUrl);
  }

  const resp = await request<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, display_name: displayName }),
  });

  await storage.setItem(KEYS.accessToken, resp.access_token);
  await storage.setItem(KEYS.refreshToken, resp.refresh_token);
  await storage.setItem(KEYS.userId, resp.user_id);

  return resp;
}

export async function refreshToken(): Promise<AuthResponse> {
  const token = await storage.getItem(KEYS.refreshToken);
  if (!token) throw new Error("No refresh token");

  const resp = await request<AuthResponse>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: token }),
  });

  await storage.setItem(KEYS.accessToken, resp.access_token);
  await storage.setItem(KEYS.refreshToken, resp.refresh_token);

  return resp;
}

export async function getDevices(): Promise<DeviceInfo[]> {
  return request<DeviceInfo[]>("/devices", { method: "GET" }, true);
}

export async function removeDevice(deviceId: string): Promise<void> {
  await request(`/devices/${deviceId}`, { method: "DELETE" }, true);
}

export async function getStoredTokens() {
  const [accessToken, refreshTokenVal, serverUrl, userId] = await Promise.all([
    storage.getItem(KEYS.accessToken),
    storage.getItem(KEYS.refreshToken),
    storage.getItem(KEYS.serverUrl),
    storage.getItem(KEYS.userId),
  ]);
  return { accessToken, refreshToken: refreshTokenVal, serverUrl, userId };
}

export async function clearTokens() {
  await Promise.all([
    storage.deleteItem(KEYS.accessToken),
    storage.deleteItem(KEYS.refreshToken),
    storage.deleteItem(KEYS.serverUrl),
    storage.deleteItem(KEYS.userId),
  ]);
}

export async function getWsUrl(): Promise<string> {
  // Ensure token is fresh before connecting
  let token = await storage.getItem(KEYS.accessToken);
  if (token && isTokenExpiringSoon(token)) {
    try {
      await refreshToken();
      token = await storage.getItem(KEYS.accessToken);
    } catch {
      // use existing token, will fail with 401 if expired
    }
  }
  const serverUrl = await getServerUrl();
  const wsUrl = serverUrl.replace(/^http/, "ws");
  return `${wsUrl}/ws?token=${token}`;
}

function isTokenExpiringSoon(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // refresh if less than 2 minutes remaining
    return payload.exp * 1000 - Date.now() < 120_000;
  } catch {
    return false;
  }
}

export async function googleAuth(idToken: string): Promise<AuthResponse> {
  const resp = await request<AuthResponse>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ id_token: idToken }),
  });

  await storage.setItem(KEYS.accessToken, resp.access_token);
  await storage.setItem(KEYS.refreshToken, resp.refresh_token);
  await storage.setItem(KEYS.userId, resp.user_id);

  return resp;
}

export interface SubscriptionStatus {
  subscribed: boolean;
  status: string | null;
  current_period_end: string | null;
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  return request<SubscriptionStatus>("/subscription/status", { method: "GET" }, true);
}

export async function createCheckout(): Promise<{ url: string }> {
  return backendRequest<{ url: string }>("/subscription/checkout", { method: "POST" });
}

export async function createPortal(): Promise<{ url: string }> {
  return backendRequest<{ url: string }>("/subscription/portal", { method: "POST" });
}

export async function getPaymentLink(): Promise<{ url: string }> {
  const serverUrl = await getServerUrl();
  const backendUrl = serverUrl === DEFAULT_SERVER ? DEFAULT_BACKEND : serverUrl;
  const resp = await fetch(`${backendUrl}/subscription/payment-link`);
  if (!resp.ok) throw new Error("Failed to get payment link");
  return resp.json();
}
