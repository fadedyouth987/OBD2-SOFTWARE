"""Large-language-model provider for AI diagnoses and copilot answers.

``LLM_PROVIDER`` picks the provider:

- ``none`` (default): no model. Diagnoses use the built-in rules and never
  touch the AI quota.
- ``bedrock``: Amazon Bedrock ``Converse`` in ``AWS_REGION`` (ap-southeast-2, so
  prompts stay in Australia) with ``BEDROCK_MODEL_ID`` (a model or inference
  profile enabled for the account in that region). Credentials come from the
  task role or the standard AWS chain.

The model only ever sees DTC codes, the vehicle platform, circuit node names and
anonymised resolved cases: never a VIN, customer or workshop detail.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Protocol

from app.config import get_settings

log = logging.getLogger(__name__)


class LlmError(RuntimeError):
    """The model call failed, timed out, refused, or returned something unusable."""


class LlmProvider(Protocol):
    name: str
    label: str

    def complete_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        """One JSON object from the model, or raise LlmError."""


def _first_json_object(text: str) -> dict[str, Any]:
    """The first top-level JSON object in ``text`` (models sometimes wrap it in prose)."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    start = text.find("{")
    if start >= 0:
        depth = 0
        in_str = False
        escape = False
        for i, ch in enumerate(text[start:], start):
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidates.append(text[start : i + 1])
                    break
    for raw in candidates:
        try:
            value = json.loads(raw)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    raise LlmError("the model did not return a JSON object")


class BedrockProvider:
    name = "bedrock"

    def __init__(self, model_id: str, region: str, timeout_s: float, client=None) -> None:
        if not model_id:
            raise LlmError("BEDROCK_MODEL_ID is not set")
        self.model_id = model_id
        self.region = region
        self.timeout_s = timeout_s
        self.label = f"Amazon Bedrock · {model_id}"
        self._client = client

    def _bedrock(self):
        if self._client is None:
            import boto3
            from botocore.config import Config

            self._client = boto3.client(
                "bedrock-runtime",
                region_name=self.region,
                config=Config(
                    read_timeout=self.timeout_s,
                    connect_timeout=5,
                    retries={"max_attempts": 1, "mode": "standard"},
                ),
            )
        return self._client

    def complete_json(self, *, system: str, prompt: str) -> dict[str, Any]:
        try:
            resp = self._bedrock().converse(
                modelId=self.model_id,
                system=[{"text": system}],
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 1500, "temperature": 0.2},
            )
        except Exception as exc:  # botocore ClientError, timeouts, missing credentials
            raise LlmError(f"Bedrock call failed: {type(exc).__name__}") from exc
        if resp.get("stopReason") in {"guardrail_intervened", "content_filtered"}:
            raise LlmError("the model refused")
        try:
            parts = resp["output"]["message"]["content"]
            text = "".join(p.get("text", "") for p in parts)
        except (KeyError, TypeError) as exc:
            raise LlmError("unexpected Bedrock response shape") from exc
        return _first_json_object(text)


_override: LlmProvider | None = None
_override_set = False


def set_provider_for_tests(provider: LlmProvider | None, *, active: bool = True) -> None:
    global _override, _override_set
    _override = provider
    _override_set = active


def configured_llm() -> LlmProvider | None:
    if _override_set:
        return _override
    s = get_settings()
    name = (s.llm_provider or "none").strip().lower()
    if name == "none":
        return None
    if name == "bedrock":
        try:
            return BedrockProvider(s.bedrock_model_id, s.aws_region, s.llm_timeout_s)
        except LlmError as exc:
            log.warning("LLM_PROVIDER=bedrock but %s; using the built-in rules", exc)
            return None
    log.warning("Unknown LLM_PROVIDER=%r; using the built-in rules", name)
    return None
