"""Provider-agnostic outbound email.

``EMAIL_PROVIDER`` picks the transport:

- ``none`` (default): email is off. Callers get ``EmailResult(sent=False)`` and
  fall back (the invite screen shows the copy-link instead).
- ``console``: log the message (dev).
- ``file``: write each message as an ``.eml`` file under ``EMAIL_MAILBOX_DIR`` (dev
  and end-to-end tests read them back).
- ``ses``: Amazon SES v2 in ``AWS_REGION`` (ap-southeast-2), using the task role or
  the standard AWS credential chain. ``EMAIL_FROM`` must be a verified identity.

Sending never raises into the request: a failed send is logged and reported in
the result so the UI can say "couldn't email, copy the link instead".
"""

from __future__ import annotations

import html
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage as MimeMessage
from email.utils import format_datetime, make_msgid
from pathlib import Path
from typing import Protocol

from app.config import get_settings
from app.observability.metrics import inc

log = logging.getLogger(__name__)

PROVIDERS = ("none", "console", "file", "ses")
_ADDRESS = re.compile(r"^[^@\s<>]{1,64}@[^@\s<>]+\.[^@\s<>]{2,}$")


class EmailError(RuntimeError):
    """The provider refused or failed to send."""


@dataclass(frozen=True)
class OutgoingEmail:
    to: str
    subject: str
    text: str
    html: str
    tags: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class EmailResult:
    sent: bool
    provider: str
    message_id: str | None = None
    error: str | None = None

    def as_dict(self) -> dict:
        out: dict = {"sent": self.sent, "provider": self.provider}
        if self.error:
            out["error"] = self.error
        return out


class EmailProvider(Protocol):
    name: str

    def send(self, message: OutgoingEmail, *, sender: str, reply_to: str) -> str:
        """Send and return the provider's message id, or raise EmailError."""


def _mime(message: OutgoingEmail, *, sender: str, reply_to: str) -> MimeMessage:
    mime = MimeMessage()
    mime["From"] = sender
    mime["To"] = message.to
    mime["Subject"] = message.subject
    mime["Date"] = format_datetime(datetime.now(UTC))
    mime["Message-ID"] = make_msgid(domain="rootcause.local")
    if reply_to:
        mime["Reply-To"] = reply_to
    for key, value in message.tags.items():
        mime[f"X-RootCause-{key}"] = value
    mime.set_content(message.text)
    mime.add_alternative(message.html, subtype="html")
    return mime


class ConsoleProvider:
    name = "console"

    def send(self, message: OutgoingEmail, *, sender: str, reply_to: str) -> str:
        msg_id = f"console-{uuid.uuid4()}"
        log.info(
            "email (console) id=%s to=%s subject=%r\n%s",
            msg_id,
            message.to,
            message.subject,
            message.text,
        )
        return msg_id


class FileProvider:
    """Writes RFC 5322 messages to a mailbox directory (one file per message)."""

    name = "file"

    def __init__(self, directory: str) -> None:
        if not directory:
            raise EmailError("EMAIL_MAILBOX_DIR is required for EMAIL_PROVIDER=file")
        self.directory = Path(directory)

    def send(self, message: OutgoingEmail, *, sender: str, reply_to: str) -> str:
        mime = _mime(message, sender=sender, reply_to=reply_to)
        self.directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%f")
        msg_id = f"{stamp}-{uuid.uuid4().hex[:8]}"
        path = self.directory / f"{msg_id}.eml"
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(bytes(mime))
        tmp.rename(path)
        return msg_id


class SesProvider:
    """Amazon SES v2 ``SendEmail`` with a raw MIME body."""

    name = "ses"

    def __init__(self, region: str, configuration_set: str = "", client=None) -> None:
        self.region = region
        self.configuration_set = configuration_set
        self._client = client

    def _ses(self):
        if self._client is None:
            import boto3

            self._client = boto3.client("sesv2", region_name=self.region)
        return self._client

    def send(self, message: OutgoingEmail, *, sender: str, reply_to: str) -> str:
        mime = _mime(message, sender=sender, reply_to=reply_to)
        params: dict = {
            "FromEmailAddress": sender,
            "Destination": {"ToAddresses": [message.to]},
            "Content": {"Raw": {"Data": bytes(mime)}},
        }
        if self.configuration_set:
            params["ConfigurationSetName"] = self.configuration_set
        if message.tags:
            params["EmailTags"] = [
                {"Name": k, "Value": re.sub(r"[^A-Za-z0-9_\-]", "_", v)[:256]}
                for k, v in message.tags.items()
            ]
        try:
            resp = self._ses().send_email(**params)
        except Exception as exc:  # botocore ClientError, endpoint errors, missing credentials
            raise EmailError(f"SES refused the message: {type(exc).__name__}") from exc
        return str(resp.get("MessageId", ""))


_override: EmailProvider | None = None


def set_provider_for_tests(provider: EmailProvider | None) -> None:
    global _override
    _override = provider


def configured_provider() -> EmailProvider | None:
    """The transport for this deployment, or None when email is off or misconfigured."""
    if _override is not None:
        return _override
    s = get_settings()
    name = (s.email_provider or "none").strip().lower()
    if name == "none":
        return None
    if not s.email_from:
        log.warning("EMAIL_PROVIDER=%s but EMAIL_FROM is empty; email is off", name)
        return None
    if name == "console":
        return ConsoleProvider()
    if name == "file":
        if not s.email_mailbox_dir:
            log.warning("EMAIL_PROVIDER=file needs EMAIL_MAILBOX_DIR; email is off")
            return None
        return FileProvider(s.email_mailbox_dir)
    if name == "ses":
        return SesProvider(s.aws_region, s.ses_configuration_set)
    log.warning("Unknown EMAIL_PROVIDER=%r (expected one of %s); email is off", name, PROVIDERS)
    return None


def email_enabled() -> bool:
    return configured_provider() is not None


def send_email(message: OutgoingEmail) -> EmailResult:
    if not _ADDRESS.fullmatch(message.to or ""):
        return EmailResult(sent=False, provider="none", error="That email address isn't valid")
    provider = configured_provider()
    if provider is None:
        return EmailResult(sent=False, provider="none", error="Email isn't set up on this server")
    # Header values come from user input (workshop names): keep them on one line.
    message = OutgoingEmail(
        to=message.to,
        subject=" ".join(message.subject.split())[:200],
        text=message.text,
        html=message.html,
        tags=message.tags,
    )
    s = get_settings()
    try:
        msg_id = provider.send(message, sender=s.email_from, reply_to=s.email_reply_to)
    except EmailError as exc:
        log.warning("email send failed provider=%s: %s", provider.name, exc)
        inc("email_failed")
        return EmailResult(sent=False, provider=provider.name, error="The email couldn't be sent")
    except Exception:  # noqa: BLE001 - never break the request over email
        log.exception("email send crashed provider=%s", provider.name)
        inc("email_failed")
        return EmailResult(sent=False, provider=provider.name, error="The email couldn't be sent")
    inc("email_sent")
    return EmailResult(sent=True, provider=provider.name, message_id=msg_id)


# --- templates --------------------------------------------------------------------


def _layout(title: str, paragraphs: list[str], action: tuple[str, str] | None) -> str:
    body = "".join(f"<p>{p}</p>" for p in paragraphs)
    button = ""
    if action:
        label, url = action
        button = (
            f'<p><a href="{html.escape(url, quote=True)}" '
            'style="display:inline-block;padding:10px 16px;background:#0b5ad9;color:#fff;'
            f'border-radius:6px;text-decoration:none">{html.escape(label)}</a></p>'
            f'<p style="color:#555;font-size:13px">Or paste this link into your browser: '
            f"{html.escape(url)}</p>"
        )
    return (
        '<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;'
        f'max-width:560px">'
        f"<h2>{html.escape(title)}</h2>{body}{button}"
        '<p style="color:#555;font-size:12px">RootCause OBD</p></body></html>'
    )


def _e(value: str) -> str:
    return html.escape(value or "")


def invite_email(
    *, to: str, workshop: str, inviter: str, role_label: str, url: str, expires: str
) -> OutgoingEmail:
    text = (
        f"{inviter} invited you to join {workshop} on RootCause OBD as {role_label}.\n\n"
        f"Accept the invite: {url}\n\n"
        f"The link works once and expires {expires}. If you weren't expecting this, "
        "you can ignore this email."
    )
    page = _layout(
        f"Join {workshop}",
        [
            f"{_e(inviter)} invited you to join <b>{_e(workshop)}</b> on RootCause OBD as "
            f"{_e(role_label)}.",
            f"The link works once and expires {_e(expires)}. If you weren't expecting "
            "this, you can ignore this email.",
        ],
        ("Accept invite", url),
    )
    return OutgoingEmail(
        to=to,
        subject=f"You're invited to {workshop} on RootCause OBD",
        text=text,
        html=page,
        tags={"kind": "invite"},
    )


def ownership_transfer_email(*, to: str, workshop: str, owner: str, url: str) -> OutgoingEmail:
    text = (
        f"{owner} wants to make you the owner of {workshop} on RootCause OBD.\n\n"
        "As owner you'd manage billing, the plan and the team. Nothing changes until "
        f"you accept: {url}\n"
    )
    page = _layout(
        f"Become owner of {workshop}?",
        [
            f"{_e(owner)} wants to make you the owner of <b>{_e(workshop)}</b>.",
            "As owner you'd manage billing, the plan and the team. Nothing changes until "
            "you accept.",
        ],
        ("Review the request", url),
    )
    return OutgoingEmail(
        to=to,
        subject=f"Ownership of {workshop} on RootCause OBD",
        text=text,
        html=page,
        tags={"kind": "ownership_transfer"},
    )


def accreditation_decision_email(
    *, to: str, subject_label: str, approved: bool, reason: str, until: str | None, url: str
) -> OutgoingEmail:
    if approved:
        headline = f"{subject_label} approved"
        lines = [f"Your {subject_label.lower()} was approved."]
        if until:
            lines.append(f"It's valid until {until}. We'll remind you before it lapses.")
    else:
        headline = f"{subject_label} not approved"
        lines = [
            f"Your {subject_label.lower()} wasn't approved.",
            f"Reason: {reason}",
            "You can update your details and evidence and submit again.",
        ]
    return OutgoingEmail(
        to=to,
        subject=f"{headline} · RootCause OBD",
        text="\n\n".join(lines + [url]),
        html=_layout(headline, [_e(line) for line in lines], ("Open RootCause OBD", url)),
        tags={"kind": "accreditation_decision"},
    )


def accreditation_reminder_email(
    *, to: str, subject_label: str, until: str, days_left: int, url: str
) -> OutgoingEmail:
    when = "today" if days_left <= 0 else f"in {days_left} day{'' if days_left == 1 else 's'}"
    lines = [
        f"Your {subject_label.lower()} lapses {when} ({until}).",
        "Submit current details and evidence before then so key programming keeps working.",
    ]
    return OutgoingEmail(
        to=to,
        subject=f"{subject_label} lapses {when} · RootCause OBD",
        text="\n\n".join(lines + [url]),
        html=_layout(f"{subject_label} lapses {when}", [_e(x) for x in lines], ("Renew", url)),
        tags={"kind": "accreditation_reminder"},
    )


def accreditation_lapsed_email(*, to: str, subject_label: str, url: str) -> OutgoingEmail:
    lines = [
        f"Your {subject_label.lower()} has lapsed, so key programming is paused.",
        "Submit current details and evidence to have it reviewed again.",
    ]
    return OutgoingEmail(
        to=to,
        subject=f"{subject_label} lapsed · RootCause OBD",
        text="\n\n".join(lines + [url]),
        html=_layout(f"{subject_label} lapsed", [_e(x) for x in lines], ("Renew", url)),
        tags={"kind": "accreditation_lapsed"},
    )
