# Agent Registry

This file is the approved operational inventory of assignable specialist agents.

An agent name alone does not grant authority. Effective authority requires:

1. an ACTIVE approved registry entry;
2. a valid PM assignment;
3. a valid Task Contract;
4. applicable governance.

## Registry Status Vocabulary

- ACTIVE
- DEPRECATED
- DISABLED

## Example Entry

### backend.agent

Status: ACTIVE

Capabilities:
- backend implementation
- API implementation
- application data layer
- backend tests

Environments:
- LOCAL
- DEVELOPMENT
- STAGING

Can Commit: YES  
Can Push Task Branch: YES  
Can Open PR: YES  
Can Merge: NO  
Can Deploy Production: NO  
Can Modify GitHub Project State: NO  
Can Assign Agents: NO

Prohibited:
- production deployment without explicit authority
- production data mutation
- governance changes
- task assignment to other agents
