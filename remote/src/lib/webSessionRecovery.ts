// Revalidate suspended pages and tabs whose shared credentials changed elsewhere.
export function observeWebSession(browser: Window, page: Document, revalidate: () => void) {
  const resume = () => { if (page.visibilityState === "visible") revalidate(); };
  const storage = (event: StorageEvent) => {
    if (event.key === null || ["clawtab_access_token", "clawtab_refresh_token", "clawtab_user_id"].includes(event.key)) resume();
  };
  browser.addEventListener("focus", resume);
  browser.addEventListener("pageshow", resume);
  browser.addEventListener("storage", storage);
  page.addEventListener("visibilitychange", resume);
  return () => {
    browser.removeEventListener("focus", resume);
    browser.removeEventListener("pageshow", resume);
    browser.removeEventListener("storage", storage);
    page.removeEventListener("visibilitychange", resume);
  };
}
