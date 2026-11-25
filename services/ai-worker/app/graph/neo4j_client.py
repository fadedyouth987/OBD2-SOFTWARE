"""Single tenant-scoped Neo4j Cypher repository (Task 3.1, A-ENG-6)."""

from __future__ import annotations

from typing import Any

from app.graph.seed_topologies import get_seed_topology


class TenantScopedGraphRepository:
    """All Cypher queries must go through this repository, which enforces a tenant_id filter."""

    def __init__(self, driver: Any = None) -> None:
        self._driver = driver

    def query_shared_dependencies(self, tenant_id: str, modules: list[str]) -> dict[str, Any]:
        if not tenant_id:
            raise ValueError("tenant_id is required for all Neo4j queries (A-ENG-6)")
        cypher = (
            "MATCH (m:EcuModule {tenant_id: $tenant_id})"
            "-[:POWERED_BY|GROUNDED_AT|ON_BUS*1..2]-(shared) "
            "WHERE m.code IN $modules AND shared.tenant_id = $tenant_id "
            "RETURN DISTINCT shared.node_id AS node_id, labels(shared) AS labels"
        )
        return {"cypher": cypher, "params": {"tenant_id": tenant_id, "modules": modules}}

    def execute_shared_dependency_query(
        self,
        tenant_id: str,
        modules: list[str],
        profile: str = "ford_ranger_px3",
    ) -> dict[str, Any]:
        """Executes against Neo4j when a driver is attached, or evaluates
        against seed topologies in local sim.
        """
        query_spec = self.query_shared_dependencies(tenant_id=tenant_id, modules=modules)
        if self._driver is not None:
            with self._driver.session() as session:
                rows = [dict(r) for r in session.run(query_spec["cypher"], **query_spec["params"])]
            return {"tenant_id": tenant_id, "source": "neo4j", "rows": rows}

        topo = get_seed_topology(profile)
        matched_modules = [m for m in modules if m in topo["modules"]]
        shared_nodes = topo["shared_nodes"] if matched_modules else []
        rows = [{"node_id": nid, "labels": ["SharedCircuitNode"]} for nid in shared_nodes]
        return {
            "tenant_id": tenant_id,
            "source": "seed_topology_sim",
            "matched_modules": matched_modules,
            "rows": rows,
        }
