"use client";

import { Button, Card } from "@/components/ui";
import { postToNative, useNativeApp } from "@/lib/native";

/**
 * Only in the Android app. The phone can read a Bluetooth dongle itself, read-only:
 * codes, readiness, freeze frame and live data. Anything that changes the car goes
 * through the edge daemon and its safety interlock, never straight over Bluetooth.
 */
export function PhoneDongleCard() {
  const native = useNativeApp();
  if (!native) return null;
  return (
    <Card title="This phone's Bluetooth dongle" subtitle="Read-only: codes, readiness, freeze frame and live data.">
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Clearing codes, service functions and key programming run through the edge daemon on the workshop computer, with
          its safety checks and audit log. The phone never sends them over Bluetooth.
        </p>
        <Button variant="primary" className="w-full sm:w-auto" onClick={() => postToNative({ type: "open-dongle" })}>
          Use a dongle with this phone
        </Button>
      </div>
    </Card>
  );
}
