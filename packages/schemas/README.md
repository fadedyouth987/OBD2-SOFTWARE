# packages/schemas

Single source of truth for wire contracts (eng review decision d3). Task 0.2 adds:

- `edge_ws.schema.json`: WebSocket messages between the web app and the edge daemon
- `safety_policy.json`: gated diagnostic services and their tiers
- Generated Rust types (`typify`) and Zod validators (`json-schema-to-zod`); CI fails on drift (A-DX-3)
