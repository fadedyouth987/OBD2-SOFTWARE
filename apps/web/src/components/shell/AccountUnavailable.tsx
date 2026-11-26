"use client";

import { Button, ButtonLink, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";

/**
 * Shown in place of a page that needs the signed-in account (`me`) before it
 * has loaded. Offline it says so and points to the vehicle tools, which keep
 * working without the cloud, instead of leaving the page blank (A-DES-2).
 */
export function AccountUnavailable({ title }: { title: string }) {
  const { offline, refresh } = useAuth();
  if (!offline) {
    return (
      <>
        <PageHeader title={title} />
        <Skeleton className="h-40" />
      </>
    );
  }
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          title="Can't load your workshop right now"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => void refresh()}>Try again</Button>
              <ButtonLink href="/devices">Open Devices</ButtonLink>
            </div>
          }
        >
          This page needs the RootCause cloud. Reading the vehicle still works: connect from Devices, or open a job you
          already have open in this browser.
        </EmptyState>
      </Card>
    </>
  );
}
