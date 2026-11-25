"use client";

import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, TextArea } from "@/components/ui";
import { useJob } from "@/context/job";

export function DetailsCard() {
  const { job, update } = useJob();
  const [form, setForm] = useState({ vehicle_label: "", odometer: "", customer_ref: "", complaint: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    if (!job) return;
    setForm({
      vehicle_label: job.vehicle_label ?? "",
      odometer: job.odometer_km?.toString() ?? "",
      customer_ref: job.customer_ref ?? "",
      complaint: job.complaint ?? "",
    });
  }, [job]);

  if (!job) return null;
  const readOnly = job.status !== "OPEN";
  const odoOk = !form.odometer || /^\d{1,7}$/.test(form.odometer);
  const dirty =
    form.vehicle_label !== (job.vehicle_label ?? "") ||
    form.odometer !== (job.odometer_km?.toString() ?? "") ||
    form.customer_ref !== (job.customer_ref ?? "") ||
    form.complaint !== (job.complaint ?? "");

  return (
    <Card title="Vehicle & customer">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMsg(null);
          try {
            await update({
              vehicle_label: form.vehicle_label.trim() || null,
              odometer_km: form.odometer ? Number(form.odometer) : null,
              customer_ref: form.customer_ref.trim() || null,
              complaint: form.complaint.trim() || null,
            });
            setMsg({ tone: "ok", text: "Saved." });
          } catch (err) {
            setMsg({ tone: "danger", text: err instanceof Error ? err.message : "Couldn't save." });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Vehicle" value={form.vehicle_label} disabled={readOnly} onChange={(e) => setForm({ ...form, vehicle_label: e.target.value })} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Odometer (km)"
            inputMode="numeric"
            value={form.odometer}
            disabled={readOnly}
            error={odoOk ? null : "Whole kilometres only."}
            onChange={(e) => setForm({ ...form, odometer: e.target.value.replace(/\D/g, "") })}
          />
          <Field label="Customer / job reference" value={form.customer_ref} disabled={readOnly} onChange={(e) => setForm({ ...form, customer_ref: e.target.value })} />
        </div>
        <TextArea label="Customer complaint" value={form.complaint} disabled={readOnly} onChange={(e) => setForm({ ...form, complaint: e.target.value })} />
        {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
        {!readOnly ? (
          <Button type="submit" size="sm" busy={busy} disabled={!dirty || !odoOk}>
            Save details
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
