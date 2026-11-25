"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui";
import { useAuth } from "@/context/auth";

export default function Index() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed_in") router.replace("/home");
    if (status === "signed_out") router.replace("/signin");
  }, [status, router]);
  return (
    <main className="flex min-h-screen items-center justify-center">
      <Spinner label="Loading…" />
    </main>
  );
}
