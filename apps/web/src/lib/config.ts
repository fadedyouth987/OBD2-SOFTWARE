// Runtime configuration. NEXT_PUBLIC_* values are inlined at build time.

export const APP_NAME = "RootCause Diagnostics";

/** This web app's version, sent to the edge daemon as HelloRequest.client_version. */
export const APP_VERSION = "0.2.0";

export const CLOUD_API_URL = (
  process.env.NEXT_PUBLIC_CLOUD_API_URL ?? "http://127.0.0.1:8000"
).replace(/\/+$/, "");

/** The edge daemon only listens on loopback. */
export const EDGE_WS_URL = process.env.NEXT_PUBLIC_EDGE_WS_URL ?? "ws://127.0.0.1:8765";

/** Every time shown to the technician is in the workshop's zone. */
export const DISPLAY_TIME_ZONE = "Australia/Adelaide";
