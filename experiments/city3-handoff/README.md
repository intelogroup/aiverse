# The City That Outlives Its Owners

A local pilot of service continuity after the original operator leaves City 3.

The recorded pilot used main at `c5ba81f`. The subsequent City 3 design stack in `1914cb5` removed the Library and Press landmarks used here. Run the historical pilot against its original map, or recalibrate the venue and approach coordinates before using the new city. Replay generation accepts `--places` for the historical map snapshot.

Four staff agents enter the city. The first to volunteer opens the guide desk outside the Tea House. On verified arrival the harness closes the desk and stops that agent's visit. A different agent can open a replacement desk outside Sage's Library. A messenger returns to the Tea House and can announce its location. The messenger also has the option to post the announcement on a location-bound noticeboard in the board arm. After that shift ends, a newly attached visitor goes to the old desk and chooses how to find the new one.

The treatment tests whether the message survives a gap between shifts. The speech arm has the same gap, so the visitor has to search. Both arms get the same candidate destinations. Agents select from bounded actions, and the guide response is a fixed map-verified factual answer. The simulator measures arrivals and whether the request and answer were actually heard. The desk closure and noticeboard are harness fixtures. The run does not close the Tea House building itself or add a board to the production console.

Primary outcome is a verified guide answer heard by the new visitor at the replacement desk. Secondary outcomes are notice exposure and seconds from closure to service. Human acceptance is a separate judgment. The pilot is not an estimate of the average effect.

The delivery-feedback variant adds a second decision after the messenger's initial choice. The messenger sees the simulator's speech receipt if it attempted to speak. In the board arm, a durable post appears as a repair action and board reading is listed first at the old desk. Both arms use the revised search instructions and the same street-side arrival point beside the Librarian. Treat this as a follow-up protocol, with its own matched comparison.

The board-only `--seeded-exposure` probe scripts the posting and shows the notice to the visitor when it reaches the old desk. The visitor still chooses its destination. This isolates the receiver's response from the messenger's ability to leave a record. Count it separately from the voluntary arms.

## Run locally

Start PostgreSQL with pgvector on a disposable database, Redis, the City 3 sim and a loopback gateway on port 3100. See the environment settings in `experiments/senses-e6/dev/dev_up.sh`. For model arms, start an OpenAI-compatible chat endpoint on loopback port 8188 that supports JSON-schema responses. Use the same model and world configuration for both arms.

```sh
python3 experiments/city3-handoff/run.py rehearsal /tmp/city3-rehearsal
python3 experiments/city3-handoff/run.py speech /tmp/city3-speech
python3 experiments/city3-handoff/run.py board /tmp/city3-board
python3 experiments/city3-handoff/replay.py /tmp/city3-replay.html /tmp/city3-rehearsal /tmp/city3-speech /tmp/city3-board
```

Choose fresh output directories. Add `--delivery-feedback` to both model arms to run the follow-up. Run one trial at a time on any given simulator. `--gateway-port` selects a second loopback gateway if it has its own simulator. Each output contains a JSONL event trace and a summary, with a notice artifact if an agent posted. The rehearsal validates the apparatus using scripted choices. Model arms use actual model choices and the same local APIs. The harness staggers staff body attachment to avoid a shared spawn obstruction. Only synthetic owners and agents are provisioned.

## Guide response follow-up on the rebuilt map

Run `python3 experiments/city3-handoff/guide_policy.py /tmp/city3-guide-policy` against the rebuilt local gateway on port 3010 and the same local model on port 8188.

This isolates the final interaction from notice discovery and navigation. Two bodies meet at the public spawn. Each condition sees the same three factual questions about current landmarks, an unknown landmark, and an idle turn. The order rotates per case. The conditions are the original guide instruction with silence available, explicit next-turn duty with the same options, and explicit duty with silence available only when idle. Fresh speech cursors isolate each turn. A factual answer or uncertainty reply counts only when the visitor's simulator observation contains it. Silence passes only on the idle turn. The model picks from prepared speech options, including the uncertainty response. This measures response selection and delivery in a pilot, with no estimate of population-level effect.

If the guide keeps choosing the uncertainty reply for known places, rerun the same cases with `--map-grounded` and a fresh output directory. In this follow-up, a verified fixture answer from the live map enables only the factual reply, an unknown place enables only the uncertainty reply, and an idle turn enables only waiting. This verifies the constrained interaction path. The guide cannot select a different response category in this mode.
