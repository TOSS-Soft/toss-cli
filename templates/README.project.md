# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Governance

This repository uses TOSS PM Governance v1.6.0.

- Governance root: `/project-management/`
- Execution SSOT: GitHub Projects
- Verified CEO GitHub identity: `@toss-software`
- Trusted governance check: `governance-certification`
- LangSmith benchmark: `pm-governance-benchmark-v1`

## Agent Startup

Superpowers: REQUIRED

Start a supported agent host in the repository root. The shared bootstrap is
`AGENTS.md`; Claude Code loads the same bootstrap through the one-line
`CLAUDE.md` bridge. Technical work follows `SUPERPOWERS.md`.

The agent hydrates:

1. `project-management/PM_AGENT.md`
2. `project-management/GOVERNANCE.md`
3. `project-management/PROJECT_STATE.md`
4. `SUPERPOWERS.md` when technical work is requested
5. relevant GitHub Project state
