# AI diagnosis fallback rate

Alert: **DiagnoseFallbackRate** (ticket). Metrics: `obd2_diagnose_total{engine,fallback_reason}`, `obd2_diagnose_duration_seconds`.

## What it means

More than 20% of diagnoses that should have used the AI model fell back to the built-in rules because the model failed (`fallback_reason="llm_error"`). Workshops still get rule-based results with their evidence, and a failed model call is never charged against their quota (A-CEO-1). The alert ignores `quota_exhausted` and `not_configured`, which are expected.

## Check

1. Search the API logs for `AI model failed for tenant=`; the message names the class: `Bedrock call failed: <Exception>`, `the model refused`, `unexpected Bedrock response shape`, `the model's answer had no usable causes`, `the model's answer was empty`.
2. **Timeouts or throttling** (`ReadTimeoutError`, `ThrottlingException`): check Bedrock service health and quotas in ap-southeast-2. `LLM_TIMEOUT_S` (default 25) can be raised slightly, but a slow model means slow diagnoses for technicians.
3. **Refusals or unusable answers**: usually a model or prompt change. Confirm `BEDROCK_MODEL_ID` is the intended model; roll back a recent prompt change in `app/services/ai_diagnostic_agent.py`.
4. **Credentials** (`AccessDeniedException`, `NoCredentialsError`): the API's IAM role lost `bedrock:InvokeModel` / Converse permission.

## Fix

- To stop all model calls while you investigate, set `LLM_PROVIDER=none` and restart. Diagnoses then use the free rules and nothing is charged.
- Restore `LLM_PROVIDER=bedrock` once a test diagnosis returns `analysis: "llm"`.
