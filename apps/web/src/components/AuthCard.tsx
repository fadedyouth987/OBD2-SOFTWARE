import { APP_NAME } from "@/lib/config";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <span aria-hidden className="h-7 w-1.5 rounded bg-accent" />
          <span className="text-lg font-extrabold tracking-tight">{APP_NAME}</span>
        </div>
        <section className="rounded-xl border border-line bg-panel p-6">
          <h1 className="text-xl font-extrabold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-5">{children}</div>
        </section>
      </div>
    </main>
  );
}
