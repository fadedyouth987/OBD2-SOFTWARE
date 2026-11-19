# Working without Docker (A-DX-5)

Some environments (sandboxed coding agents, locked-down machines) can't run Docker or can't pull from Docker Hub. Nothing in this repo should leave you stuck.

## What still works without Docker

- `just bootstrap`, `just lint`, `just test` and `pnpm build`: none of these need infrastructure today.
- Unit tests for the Rust daemon run against the in-memory `VirtualBusAdapter` and `VirtualKLineAdapter` (Task 1.1) and recorded serial byte streams (`apps/edge-daemon/fixtures/hal/`), never real hardware or containers.
- The SocketCAN test needs a `vcan0` interface and is `#[ignore]`d by default: `sudo ip link add dev vcan0 type vcan && sudo ip link set vcan0 up`, then `cargo test -p edge-daemon -- --ignored socketcan`.

## Gates that need infrastructure

| Gate | No-Docker path |
| --- | --- |
| Task 0.1 infrastructure gate (`just infra-gate`) | Push the branch: the `quickstart` GitHub Actions job runs the same script on a runner that can pull images. Treat that job's result as the gate. |
| Later database gates (Tasks 2.1–2.2) | Same: CI service containers. Integration tests skip with a clear "needs Postgres" message when `DATABASE_URL` is unreachable, and never report a pass. |
| Neo4j gates (Task 3.1) | Same: CI service containers. |

## Native alternative

If you can install packages but not run Docker: PostgreSQL 16 with the TimescaleDB and pgvector (≥ 0.8.0) extensions, Neo4j 5 with APOC, Redis 7, and any S3-compatible store. Point the variables in `.env` at them. `scripts/infra-gate.sh` itself expects Docker Compose, so verify the extensions by hand:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname IN ('timescaledb', 'vector');
```
