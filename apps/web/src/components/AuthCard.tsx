import { Wordmark } from "@/components/brand/Logo";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Wordmark width={300} />
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
