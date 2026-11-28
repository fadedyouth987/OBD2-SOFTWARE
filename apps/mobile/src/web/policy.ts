// What the web view may load. The web app runs inside the app with the site's own
// origin, so everything on that origin is allowed; nothing else is.

export type NavDecision =
  | { action: "allow" }
  /** Open in the phone's browser (docs, the provider's own pages, mailto:, tel:). */
  | { action: "external"; url: string }
  /** Never: in-app purchases go through the website (Google Play rules). */
  | { action: "block"; reason: "purchase" | "scheme" };

const PURCHASE_HOSTS = ["checkout.stripe.com", "billing.stripe.com", "buy.stripe.com"];

export function decideNavigation(raw: string, appOrigin: string): NavDecision {
  if (raw === "about:blank") return { action: "allow" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { action: "block", reason: "scheme" };
  }
  if (url.origin === appOrigin) return { action: "allow" };
  if (url.protocol === "mailto:" || url.protocol === "tel:") return { action: "external", url: raw };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { action: "block", reason: "scheme" };
  if (PURCHASE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    return { action: "block", reason: "purchase" };
  }
  return { action: "external", url: raw };
}
