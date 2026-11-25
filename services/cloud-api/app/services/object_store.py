"""Tenant file storage on S3 (SeaweedFS locally, S3 in ap-southeast-2 in AWS).

Every key starts with the kind and the tenant id, so one workshop's files can
never be addressed through another's rows. Objects are private; the API
streams them to signed-in members only.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any
from uuid import UUID

from app.config import get_settings


class StorageError(RuntimeError):
    """Object storage couldn't be reached or refused the request."""


@lru_cache(maxsize=1)
def _client() -> Any:
    import boto3
    from botocore.config import Config

    s = get_settings()
    kwargs: dict[str, Any] = {
        "region_name": s.aws_region,
        "config": Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 2, "mode": "standard"},
            connect_timeout=3,
            read_timeout=20,
        ),
    }
    if s.s3_endpoint_url:
        kwargs["endpoint_url"] = s.s3_endpoint_url
    if s.s3_access_key_id and s.s3_secret_access_key:
        kwargs["aws_access_key_id"] = s.s3_access_key_id
        kwargs["aws_secret_access_key"] = s.s3_secret_access_key
    return boto3.client("s3", **kwargs)


def object_key(kind: str, tenant_id: UUID, object_id: UUID, ext: str) -> str:
    if kind not in {"schematics", "dbc", "accreditation"}:
        raise ValueError(f"unknown object kind {kind!r}")
    return f"{kind}/{tenant_id}/{object_id}.{ext.lstrip('.')}"


def key_belongs_to(key: str, tenant_id: UUID) -> bool:
    parts = key.split("/")
    return len(parts) == 3 and parts[1] == str(tenant_id)


def put(key: str, data: bytes, content_type: str) -> None:
    try:
        _client().put_object(
            Bucket=get_settings().s3_bucket, Key=key, Body=data, ContentType=content_type
        )
    except Exception as exc:  # botocore raises many types; callers need one
        raise StorageError(str(exc)) from exc


def get(key: str) -> bytes:
    try:
        obj = _client().get_object(Bucket=get_settings().s3_bucket, Key=key)
        return obj["Body"].read()
    except Exception as exc:
        raise StorageError(str(exc)) from exc


def delete(key: str) -> None:
    try:
        _client().delete_object(Bucket=get_settings().s3_bucket, Key=key)
    except Exception as exc:
        raise StorageError(str(exc)) from exc
