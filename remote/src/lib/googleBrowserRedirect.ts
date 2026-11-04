export type BrowserGoogleRequest = { url: string | null; state: string };

export function beginGoogleBrowserRedirect(_request: BrowserGoogleRequest | null, _destination: string): boolean {
  return false;
}

export function completeGoogleBrowserRedirect(_params: URLSearchParams): boolean {
  return false;
}
