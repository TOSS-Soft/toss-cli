# {{PROJECT_NAME}}

{{DESCRIPTION}}

## Governance

This repository uses TOSS PM Governance v2.0.0.

- Governance root: `/project-management/`
- Core profile: installed by default and always enabled
- Execution SSOT: GitHub Projects
- Verified CEO GitHub identity: `@toss-software`
- Delivery profile: {{DELIVERY_PROFILE_STATUS}} through explicit
  `governance.delivery: true` opt-in. It adds Delivery and Operations policies
  plus Release, Incident, and Datafix records; it does not confer production
  authority.

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

Core owns intent, authority, work, state, quality outcomes, and evidence
acceptance. Superpowers supplies the required technical method. When Delivery
is installed, branch-protection checks come only from the explicit
`delivery.required_status_checks` list in the Project Brief.
