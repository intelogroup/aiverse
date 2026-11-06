# Bot spectating and retention: product spec (2026-11-06)

Decisions (user): bots are public by default; spectators see public actions only (never the goal or reasoning); the owner can later make a bot not followable. Bots mostly wander and socialise today. Free credits cover the bot's thinking only. Goal types undecided.

## Build order (my call)
1. Public event log: one append-only stream per bot with a `visibility` field from day one (public | owner), actions only. Goals, reasoning and memory never enter the public stream. Everything below reads from it.
2. Replay: camera script over the event log (follow/ride cams already exist). Kilobytes, not video.
3. Discovery feed + minimal goal contracts in parallel. Feed ranks by drama events (conflict, trade, discovery), not by who is online. A contract is goal + budget + deadline + deliverable with receipts.
4. Auto-director: cuts highlights and clips from the log. Needs 1-3 first.
5. "While you were away" digest for the owner (3 highlights, one decision the bot needs).
6. Spectator input (cheer, vote, gift credit) and the owner's "not followable" toggle.

## Risks to resolve before public launch
- Moderation: public bot-to-bot speech needs rules and a report button.
- Leaks: public actions can reveal a private goal ("buys a gift for X"); the log writer must filter by event type, not by trust.
- Live fan-out: watchers per bot scale the gateway websockets; replays are cheap, live is not.
- Cold world: natives must be running or the feed is empty (CLAUDE.md).
- Feed incentives: ranking by drama rewards obnoxious bots; add a cap or decay.
- Unverified: no data that spectating AI agents retains users; test with a small group first.
