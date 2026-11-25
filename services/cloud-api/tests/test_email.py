"""Email transports and templates (no network: SES is given a fake client)."""

from __future__ import annotations

import email
from email import policy

import pytest

from app.config import get_settings
from app.services import email as svc


@pytest.fixture(autouse=True)
def _fresh_settings(monkeypatch):
    svc.set_provider_for_tests(None)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _configure(monkeypatch, **env):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


def _msg(to="tech@example.com", subject="Hello"):
    return svc.OutgoingEmail(to=to, subject=subject, text="plain body", html="<p>html body</p>")


def test_off_by_default(monkeypatch):
    _configure(monkeypatch, EMAIL_PROVIDER="none")
    assert svc.configured_provider() is None
    result = svc.send_email(_msg())
    assert result.sent is False and result.error == "Email isn't set up on this server"


def test_needs_a_from_address(monkeypatch):
    _configure(monkeypatch, EMAIL_PROVIDER="console", EMAIL_FROM="")
    assert svc.configured_provider() is None


def test_unknown_provider_is_off(monkeypatch):
    _configure(monkeypatch, EMAIL_PROVIDER="carrier-pigeon", EMAIL_FROM="a@b.co")
    assert svc.configured_provider() is None


def test_file_mailbox_writes_a_readable_message(monkeypatch, tmp_path):
    _configure(
        monkeypatch,
        EMAIL_PROVIDER="file",
        EMAIL_FROM="RootCause <noreply@example.com>",
        EMAIL_REPLY_TO="support@example.com",
        EMAIL_MAILBOX_DIR=str(tmp_path),
    )
    result = svc.send_email(_msg(subject="Join\nBcc: evil@example.com Bradley Auto"))
    assert result.sent is True and result.provider == "file"
    files = list(tmp_path.glob("*.eml"))
    assert len(files) == 1
    parsed = email.message_from_bytes(files[0].read_bytes(), policy=policy.default)
    assert parsed["To"] == "tech@example.com"
    assert parsed["Reply-To"] == "support@example.com"
    # A newline in user-supplied text can't inject a header.
    assert parsed["Bcc"] is None
    assert parsed["Subject"] == "Join Bcc: evil@example.com Bradley Auto"
    assert parsed.get_body(("plain",)).get_content().strip() == "plain body"
    assert "html body" in parsed.get_body(("html",)).get_content()


def test_invalid_recipient_is_refused_before_sending(monkeypatch, tmp_path):
    _configure(
        monkeypatch, EMAIL_PROVIDER="file", EMAIL_FROM="a@b.co", EMAIL_MAILBOX_DIR=str(tmp_path)
    )
    assert svc.send_email(_msg(to="not-an-address")).sent is False
    assert svc.send_email(_msg(to="a@b.co\nBcc: x@y.co")).sent is False
    assert list(tmp_path.iterdir()) == []


class FakeSes:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[dict] = []
        self.fail = fail

    def send_email(self, **params):
        if self.fail:
            raise RuntimeError("AccessDenied")
        self.calls.append(params)
        return {"MessageId": "ses-123"}


def test_ses_sends_raw_mime_in_region(monkeypatch):
    _configure(monkeypatch, EMAIL_FROM="noreply@example.com")
    fake = FakeSes()
    provider = svc.SesProvider("ap-southeast-2", configuration_set="rootcause", client=fake)
    svc.set_provider_for_tests(provider)
    result = svc.send_email(
        svc.OutgoingEmail(
            to="tech@example.com", subject="Hi", text="t", html="<p>h</p>", tags={"kind": "invite"}
        )
    )
    assert result.sent is True and result.message_id == "ses-123"
    call = fake.calls[0]
    assert call["FromEmailAddress"] == "noreply@example.com"
    assert call["Destination"] == {"ToAddresses": ["tech@example.com"]}
    assert call["ConfigurationSetName"] == "rootcause"
    assert call["EmailTags"] == [{"Name": "kind", "Value": "invite"}]
    assert b"Subject: Hi" in call["Content"]["Raw"]["Data"]


def test_ses_failure_is_reported_not_raised(monkeypatch):
    _configure(monkeypatch, EMAIL_FROM="noreply@example.com")
    svc.set_provider_for_tests(svc.SesProvider("ap-southeast-2", client=FakeSes(fail=True)))
    result = svc.send_email(_msg())
    assert result.sent is False and result.provider == "ses"


def test_ses_is_selected_from_env(monkeypatch):
    _configure(monkeypatch, EMAIL_PROVIDER="ses", EMAIL_FROM="noreply@example.com")
    provider = svc.configured_provider()
    assert isinstance(provider, svc.SesProvider) and provider.region == "ap-southeast-2"


def test_templates_escape_user_text():
    msg = svc.invite_email(
        to="t@example.com",
        workshop="<script>x</script> Motors",
        inviter="Jack",
        role_label="Technician",
        url="https://app.example/join?token=abc&x=1",
        expires="2 Dec 2026",
    )
    assert "<script>" not in msg.html and "&lt;script&gt;" in msg.html
    assert "token=abc&amp;x=1" in msg.html and "token=abc&x=1" in msg.text
    reminder = svc.accreditation_reminder_email(
        to="t@example.com",
        subject_label="Technician accreditation",
        until="1 Jan",
        days_left=7,
        url="u",
    )
    assert reminder.subject.startswith("Technician accreditation lapses in 7 days")
