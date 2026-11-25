"use client";

import { Banner } from "@/components/ui";
import { useAuth } from "@/context/auth";

/** Platform-admin pages. The API enforces this too; this just avoids a page of 403s. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  if (!me) return null;
  if (!me.platform_admin) {
    return (
      <Banner tone="warn" title="This page is for RootCause platform admins">
        Platform admin is granted from the server command line, not from a workshop role.
      </Banner>
    );
  }
  return <>{children}</>;
}
