"use client";

// Client component: the shared card and buttons come from client-only modules.
import { AuthCard } from "@/components/AuthCard";
import { ButtonLink } from "@/components/ui";

/** Any unknown URL: say so plainly and offer the way back, in the app's own look. */
export default function NotFound() {
  return (
    <AuthCard title="Page not found" subtitle="That address doesn't match a page in RootCause. Check the link, or start again from home.">
      <div className="flex flex-wrap gap-2">
        <ButtonLink href="/home" variant="primary">
          Go to home
        </ButtonLink>
        <ButtonLink href="/jobs">Vehicles &amp; jobs</ButtonLink>
      </div>
    </AuthCard>
  );
}
