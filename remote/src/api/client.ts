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

  let originalToken: string | null = null;
  if (useAuth) {
    originalToken = await storage.getItem(KEYS.accessToken);
    if (originalToken) {
      headers["Authorization"] = `Bearer ${originalToken}`;
    }
  }

  let resp = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers,
  });

  // Auto-refresh on 401 for authenticated requests
  if (resp.status === 401 && useAuth) {
    try {
      // Check if another request already refreshed the token
      const currentToken = await storage.getItem(KEYS.accessToken);
      if (currentToken && currentToken !== originalToken) {
        // Token was already refreshed by a concurrent request, just retry
        headers["Authorization"] = `Bearer ${currentToken}`;
      } else {
        await refreshToken();
        const newToken = await storage.getItem(KEYS.accessToken);
        if (newToken) {
          headers["Authorization"] = `Bearer ${newToken}`;
        }
      }
      resp = await fetch(`${serverUrl}${path}`, { ...options, headers });
    } catch {
      // refresh failed, throw the original 401
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let message = `HTTP ${resp.status}`;
    if (text) {
      try {
        const json = JSON.parse(text);
        message = json.error || json.message || text;
      } catch {
        message = text;
      }
    }
    throw new Error(message);
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

  const originalToken = await storage.getItem(KEYS.accessToken);
  if (originalToken) {
    headers["Authorization"] = `Bearer ${originalToken}`;
  }

  let resp = await fetch(`${backendUrl}${path}`, {
    ...options,
    headers,
  });

  if (resp.status === 401) {
    try {
      const currentToken = await storage.getItem(KEYS.accessToken);
      if (currentToken && currentToken !== originalToken) {
        headers["Authorization"] = `Bearer ${currentToken}`;
      } else {
        await refreshToken();
        const newToken = await storage.getItem(KEYS.accessToken);
        if (newToken) {
          headers["Authorization"] = `Bearer ${newToken}`;
        }
      }
      resp = await fetch(`${backendUrl}${path}`, { ...options, headers });
    } catch {
      // refresh failed
    }
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let message = `HTTP ${resp.status}`;
    if (text) {
      try {
        const json = JSON.parse(text);
        message = json.error || json.message || text;
      } catch {
        message = text;
      }
    }
    throw new Error(message);
  }

  return resp.json();
}

// Deduplicate concurrent refresh calls to prevent refresh token reuse,
// which triggers stolen-token detection and revokes all tokens.
let refreshInFlight: Promise<AuthResponse> | null = null;

export async function refreshToken(): Promise<AuthResponse> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const token = await storage.getItem(KEYS.refreshToken);
    if (!token) throw new Error("No refresh token");

    const resp = await request<AuthResponse>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: token }),
    });

    await storage.setItem(KEYS.accessToken, resp.access_token);
    await storage.setItem(KEYS.refreshToken, resp.refresh_token);

    return resp;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
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

export async function appleAuth(
  idToken: string,
  displayName?: string,
  email?: string,
): Promise<AuthResponse> {
  const resp = await request<AuthResponse>("/auth/apple", {
    method: "POST",
    body: JSON.stringify({ id_token: idToken, display_name: displayName, email }),
  });

  await storage.setItem(KEYS.accessToken, resp.access_token);
  await storage.setItem(KEYS.refreshToken, resp.refresh_token);
  await storage.setItem(KEYS.userId, resp.user_id);

  return resp;
}

export interface VerifyReceiptRequest {
  original_transaction_id: string;
  product_id: string;
  expires_date_ms?: number;
}

export async function verifyIapReceipt(req: VerifyReceiptRequest): Promise<{ subscribed: boolean }> {
  return request<{ subscribed: boolean }>("/iap/verify-receipt", {
    method: "POST",
    body: JSON.stringify(req),
  }, true);
}

export interface SubscriptionStatus {
  subscribed: boolean;
  status: string | null;
  current_period_end: string | null;
  provider: string | null;
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

export interface ShareInfo {
  id: string;
  email: string;
  display_name: string | null;
  allowed_groups: string[] | null;
  created_at: string;
}

export interface SharedWithMeInfo {
  id: string;
  owner_email: string;
  owner_display_name: string | null;
  allowed_groups: string[] | null;
  created_at: string;
}

export interface SharesResponse {
  shared_by_me: ShareInfo[];
  shared_with_me: SharedWithMeInfo[];
}

export async function getShares(): Promise<SharesResponse> {
  return request<SharesResponse>("/shares", { method: "GET" }, true);
}

export async function addShare(email: string, allowedGroups?: string[]): Promise<ShareInfo> {
  return request<ShareInfo>(
    "/shares",
    { method: "POST", body: JSON.stringify({ email, allowed_groups: allowedGroups ?? null }) },
    true,
  );
}

export async function updateShare(shareId: string, allowedGroups: string[] | null): Promise<void> {
  await request(`/shares/${shareId}`, {
    method: "PATCH",
    body: JSON.stringify({ allowed_groups: allowedGroups }),
  }, true);
}

export async function deleteAccount(): Promise<void> {
  await request("/account", { method: "DELETE" }, true);
}

export async function removeShare(shareId: string): Promise<void> {
  await request(`/shares/${shareId}`, { method: "DELETE" }, true);
}

export async function postAnswer(
  questionId: string,
  paneId: string,
  answer: string,
): Promise<{ sent: boolean }> {
  return request<{ sent: boolean }>(
    "/api/answer",
    {
      method: "POST",
      body: JSON.stringify({
        question_id: questionId,
        pane_id: paneId,
        answer,
      }),
    },
    true,
  );
}
