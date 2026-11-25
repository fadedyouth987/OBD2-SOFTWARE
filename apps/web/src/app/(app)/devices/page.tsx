"use client";

import { AdapterPicker } from "@/components/edge/AdapterPicker";
import { DaemonPanel } from "@/components/edge/DaemonPanel";
import { DeviceGuides } from "@/components/edge/DeviceGuides";
import { LeaseCard } from "@/components/edge/LeaseCard";
import { Card, PageHeader } from "@/components/ui";

export default function DevicesPage() {
  return (
    <>
      <PageHeader
        title="Devices"
        subtitle="Connect the edge daemon, choose an adapter and check what this computer is licensed to do."
      />
      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <DaemonPanel />
          <Card title="Adapters" subtitle="Everything the daemon found on this computer.">
            <AdapterPicker />
          </Card>
        </div>
        <div className="space-y-4">
          <LeaseCard />
          <DeviceGuides />
        </div>
      </div>
    </>
  );
}
