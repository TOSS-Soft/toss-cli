# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Governance

This repository uses TOSS PM Governance v2.0.0.

- Governance root: `/project-management/`
- Execution SSOT: GitHub Projects
- Verified CEO GitHub identity: `@toss-software`

## Agent Startup

Superpowers: REQUIRED

Start a supported agent host in the repository root. The shared bootstrap is
`AGENTS.md`; Claude Code loads the same bootstrap through the one-line
`CLAUDE.md` bridge. Technical work follows `SUPERPOWERS.md`.

The agent hydrates:

1. `project-management/GOVERNANCE.md`
2. `project-management/WORK.md`
3. `project-management/QUALITY.md`
4. `project-management/PROJECT_STATE.md`
5. `SUPERPOWERS.md` before technical work
6. relevant GitHub Project state
