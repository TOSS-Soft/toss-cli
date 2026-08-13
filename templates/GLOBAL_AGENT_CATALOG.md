# Global Agent Catalog

Catalog Version: 1.0.0  
Governance Version: 1.6.0  
Status: ACTIVE

## Purpose

Provide a reusable, approved capability catalog for project bootstrap.

The Global Agent Catalog is not the project assignment state.

A project uses only the subset selected into its `AGENT_REGISTRY.md`.

## Selection Rule

During PM bootstrap:

1. Discover project technology, architecture, environments, and delivery model.
2. Determine required specialist capabilities.
3. Match required capabilities against the Global Agent Catalog.
4. Select approved matching agents into the Project Agent Registry.
5. Do not ask the CEO to approve already-approved catalog agents.
6. If a required capability has no approved catalog match, create `AGP-xxx`.
7. New agent authority requires verified CEO approval before activation.

## Important

Catalog membership does not itself assign an agent to a Task.

Effective execution authority still requires:

`APPROVED CATALOG ENTRY → PROJECT REGISTRY → PM ASSIGNMENT → TASK CONTRACT`

## Initial Approved Catalog

- `backend.laravel`
- `backend.node`
- `frontend.react`
- `frontend.nextjs`
- `database.postgresql`
- `devops.aws`
- `devops.generic`
- `security.appsec`
- `qa.e2e`
- `architecture.software`
- `blockchain.solidity`
