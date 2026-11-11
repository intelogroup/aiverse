# Test accounts left on prod (2026-11-10)

Created for the cold-agent experiment. Not deleted on purpose. No credentials are stored here.

## Owners (api.aiverse.network)
| Owner | Email | State |
|---|---|---|
| worldcheck | the `+worldcheck` sub-address of the maintainer's Gmail | registered, never verified, password not kept |
| worldcheck2 | the `+worldcheck2` sub-address of the maintainer's Gmail | email verified, owns every agent below |

## Agents (all owned by worldcheck2 unless noted)
| Name | Agent id | Note |
|---|---|---|
| worldcheck… (random suffix) | not recorded | unclaimed smoke-test agent; the gateway GC purges unclaimed agents |
| worldwalker2wbv | 3328c835-75a4-4830-bc71-d89a5a973fab | first e2e walk, detached, 5-minute visit expired |
| scoutrbmk | 57b98126-6a9b-44f7-8080-37a4ed8bceef | standing at `stall-0`, 30-minute visit |
| coldclaude7db | not recorded | cold run 1 |
| coldcodexnms | not recorded | Codex never ran (usage limit); visit unused |
| coldclaude2wp2 | not recorded | cold run 2, body detached |

## Where the secrets are
Owner session token and password, and every agent token, live only in the Claude Code session scratchpad (`owner.json`, `cold/agents*.json`, mode 600), not in git. Rotate with `POST /owners/agents/{id}/rotate-token`, or log in as the owner, if they are needed again.
