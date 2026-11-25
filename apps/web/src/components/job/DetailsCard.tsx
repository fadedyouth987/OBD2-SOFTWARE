"use client";

import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, TextArea } from "@/components/ui";
import { useJob } from "@/context/job";

export function DetailsCard() {
  const { job, update } = useJob();
  const [form, setForm] = useState({
    vehicle_label: "",
    odometer: "",
    customer_ref: "",
    complaint: "",
    vehicle_make: "",
    vehicle_model: "",
    model_year: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  useEffect(() => {
    if (!job) return;
    setForm({
      vehicle_label: job.vehicle_label ?? "",
      odometer: job.odometer_km?.toString() ?? "",
      customer_ref: job.customer_ref ?? "",
      complaint: job.complaint ?? "",
      vehicle_make: job.vehicle_make ?? "",
      vehicle_model: job.vehicle_model ?? "",
      model_year: job.model_year?.toString() ?? "",
    });
  }, [job]);

  if (!job) return null;
  const readOnly = job.status !== "OPEN" || job.can_edit === false;
  const odoOk = !form.odometer || /^\d{1,7}$/.test(form.odometer);
  const thisYear = new Date().getFullYear();
  const year = form.model_year ? Number(form.model_year) : null;
  const yearOk = year === null || (year >= 1980 && year <= thisYear + 1);
  const dirty =
    form.vehicle_label !== (job.vehicle_label ?? "") ||
    form.odometer !== (job.odometer_km?.toString() ?? "") ||
    form.customer_ref !== (job.customer_ref ?? "") ||
    form.complaint !== (job.complaint ?? "") ||
    form.vehicle_make !== (job.vehicle_make ?? "") ||
    form.vehicle_model !== (job.vehicle_model ?? "") ||
    form.model_year !== (job.model_year?.toString() ?? "");

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
              vehicle_make: form.vehicle_make.trim() || null,
              vehicle_model: form.vehicle_model.trim() || null,
              model_year: year,
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
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-semibold">Make, model and year</legend>
          <p className="mb-2 text-xs text-muted">
            Used to look up licensed service procedures. Filled in from the VIN where it can be; check it matches the car.
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_7rem]">
            <Field label="Make" value={form.vehicle_make} maxLength={80} disabled={readOnly} placeholder="e.g. Ford" onChange={(e) => setForm({ ...form, vehicle_make: e.target.value })} />
            <Field label="Model" value={form.vehicle_model} maxLength={120} disabled={readOnly} placeholder="e.g. Ranger PX3" onChange={(e) => setForm({ ...form, vehicle_model: e.target.value })} />
            <Field
              label="Year"
              inputMode="numeric"
              value={form.model_year}
              disabled={readOnly}
              error={yearOk ? null : `1980 to ${thisYear + 1}.`}
              onChange={(e) => setForm({ ...form, model_year: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
          </div>
        </fieldset>
        <TextArea label="Customer complaint" value={form.complaint} disabled={readOnly} onChange={(e) => setForm({ ...form, complaint: e.target.value })} />
        {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
        {!readOnly ? (
          <Button type="submit" size="sm" busy={busy} disabled={!dirty || !odoOk || !yearOk}>
            Save details
          </Button>
        ) : null}
      </form>
    </Card>
  );
}
