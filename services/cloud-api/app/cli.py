"""Operator commands: ``uv run python -m app.cli <command> ...``.

grant-platform-admin EMAIL     let an existing user review accreditation and import procedures
revoke-platform-admin EMAIL
accreditation-reminders        send "lapses soon" emails and lapse expired approvals (run daily)
import-procedures FILE         import a licensed procedure JSON file (docs/dev/oem-procedures.md)
sync-procedures                pull the licensed provider feed (PROCEDURE_PROVIDER_FEED_URL)
drain-can-traces               upload raw CAN traces S3 refused at sync time (run every few minutes)
"""

from __future__ import annotations

import json
import sys


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help", "help"}:
        print(__doc__)
        return 0
    command, args = argv[0], argv[1:]
    if command in {"grant-platform-admin", "revoke-platform-admin"} and len(args) == 1:
        from app.services.accreditation import set_platform_admin

        ok = set_platform_admin(args[0], command.startswith("grant"))
        print("updated" if ok else f"no user with email {args[0]!r}")
        return 0 if ok else 1
    if command == "accreditation-reminders" and not args:
        from app.services.accreditation import run_reminders

        print(json.dumps(run_reminders()))
        return 0
    if command == "import-procedures" and len(args) == 1:
        from fastapi import HTTPException

        from app.services.procedures import import_document

        try:
            with open(args[0], encoding="utf-8") as fh:
                result = import_document(json.load(fh), imported_by=None)
        except (HTTPException, ValueError) as exc:
            print(
                json.dumps(getattr(exc, "detail", str(exc)), indent=2, ensure_ascii=False),
                file=sys.stderr,
            )
            return 1
        print(json.dumps(result))
        return 0
    if command == "sync-procedures" and not args:
        from fastapi import HTTPException

        from app.services.procedures import sync_from_provider

        try:
            print(json.dumps(sync_from_provider(imported_by=None)))
        except HTTPException as exc:
            print(exc.detail, file=sys.stderr)
            return 1
        return 0
    if command == "drain-can-traces" and not args:
        from sqlalchemy import create_engine

        from app.config import get_settings
        from app.services.can_traces import drain

        engine = create_engine(get_settings().migration_database_url)  # owner: every tenant
        try:
            pending = drain(engine)
        finally:
            engine.dispose()
        print(json.dumps({"pending": pending}))
        return 0 if pending == 0 else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
