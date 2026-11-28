import { requireOptionalNativeModule, type EventSubscription } from "expo";
import type { CloseReason, DaemonLinkLike, LinkEvents } from "../../src/lan/native";

interface DaemonLinkNative {
  connect(id: string, url: string, pin: string, authorization: string, origin: string): Promise<void>;
  send(id: string, text: string): Promise<boolean>;
  close(id: string): Promise<void>;
  addListener(event: "onOpen", cb: (e: { id: string }) => void): EventSubscription;
  addListener(event: "onMessage", cb: (e: { id: string; text: string }) => void): EventSubscription;
  addListener(
    event: "onClose",
    cb: (e: { id: string; wasOpen: boolean; reason: CloseReason; detail?: string | null }) => void,
  ): EventSubscription;
}

let cached: DaemonLinkNative | null | undefined;
function native(): DaemonLinkNative {
  if (cached === undefined) cached = requireOptionalNativeModule<DaemonLinkNative>("DaemonLink");
  if (!cached) throw new Error("This app version can't connect to a workshop PC. Update the RootCause app.");
  return cached;
}

/** The pinned TLS link to the workshop PC (Kotlin, OkHttp). Android only. */
export const DaemonLink: DaemonLinkLike = {
  connect: async (id, url, pin, authorization, origin) => native().connect(id, url, pin, authorization, origin),
  send: async (id, text) => native().send(id, text),
  close: async (id) => native().close(id),
  subscribe(h: LinkEvents) {
    const n = native();
    const subs = [
      n.addListener("onOpen", (e) => h.onOpen(e)),
      n.addListener("onMessage", (e) => h.onMessage(e)),
      n.addListener("onClose", (e) => h.onClose({ ...e, detail: e.detail ?? undefined })),
    ];
    return () => subs.forEach((s) => s.remove());
  },
};
