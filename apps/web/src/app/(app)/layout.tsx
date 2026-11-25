"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { Spinner } from "@/components/ui";
import { ActiveJobProvider } from "@/context/active-job";
import { useAuth } from "@/context/auth";
import { EdgeProvider } from "@/context/edge";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (status === "signed_out") router.replace(`/signin?next=${encodeURIComponent(path)}`);
  }, [status, router, path]);

  if (status !== "signed_in") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner label={status === "loading" ? "Loading your workshop…" : "Redirecting to sign in…"} />
      </main>
    );
  }
  return (
    <EdgeProvider>
      <ActiveJobProvider>
        <AppShell>{children}</AppShell>
      </ActiveJobProvider>
    </EdgeProvider>
  );
}
