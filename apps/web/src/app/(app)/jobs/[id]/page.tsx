"use client";

import { Suspense } from "react";
import { AlertsCard } from "@/components/job/AlertsCard";
import { DetailsCard } from "@/components/job/DetailsCard";
import { DiagnosisSummary } from "@/components/job/DiagnosisSummary";
import { DtcCard } from "@/components/job/DtcCard";

export default function JobOverviewPage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <div className="space-y-4">
        <Suspense>
          <DtcCard />
        </Suspense>
        <AlertsCard />
      </div>
      <div className="space-y-4">
        <DiagnosisSummary />
        <DetailsCard />
      </div>
    </div>
  );
}
