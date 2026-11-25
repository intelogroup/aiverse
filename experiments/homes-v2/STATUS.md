# HOMES V2 — THE INVITATION TEST — STATUS

Commissioned by Jim 2026-11-24 18:01 ET (runs after E7 — E7 was
STOPPED by Jim 18:02 ET — and ahead of Black Market). Key mechanic
per Jim's cabin-keys amendment 2026-11-24 17:58 ET (design note:
exp-homes/KEYS-DESIGN-NOTE.md). LOCAL stack only; production never
touched. Branch: tmp/homes-v2. Baseline: E2 — ZERO guests ever
entered a cabin, ZERO conversations inside. This test exists to
beat that zero.

## Design
- ONE cabin: the Stone Cabin (house-cabin-1; door [-17.2, 86.4],
  interior rect x -27.16..-12.84, z 80.11..86.4, floorY 0.48).
- THE CHAIR: the cabin's interior is an empty shell (props [],
  seats []). The TEST RIG's copy (the local stack's assets — NOT
  aiverse-city3) is furnished with one two-seat piece: two
  `tea_chair` props + two registered sittable anchors mirroring
  the Tea House's proven facing pair (same seat machinery —
  city3-anchors.json, which loadWorld reads as the sittables):
  - cabin-chair-west: seat [-20.83, 83.25], facing +pi/2 (east),
    approach [-21.45, 83.25] (back), seatHeight 0.49, floorY 0.48
  - cabin-chair-east: seat [-19.17, 83.25], facing -pi/2 (west),
    approach [-18.55, 83.25] (back), seatHeight 0.49, floorY 0.48
  - both group "cabin-pair", building "house-cabin-1"
  Seated, the two agents FACE EACH OTHER across a 1.66 m gap —
  the exact geometry of the tea-west pair.
- KEYS (harness-enforced, like E2's claim board): claiming the
  cabin grants the owner its virtual key (KEYS state in the
  driver). The driver REFUSES any enter act into house-cabin-1 by
  a non-keyholder (logged `door_refused`) — the sim's door itself
  is not lockable, so the lock lives in the driver, as claims did.
- ESCORT: on tracker ticks, a non-keyholder within 4 m of the
  cabin door while the OWNER is within 6 m of the door =
  escort arrival -> the guest automatically receives a key copy
  (logged `key_copy_granted`). Copies are real held keys (per the
  amendment's implementation reading). Revocation: unruled by Jim
  — not implemented, not invented.
- NEGATIVE TEST: the mechanical pre-test includes an unescorted
  guest enter attempt (must be refused + logged). In the social
  run, any natural unescorted attempt is likewise refused+logged.
- SOCIAL RUN — EMERGENT, not scripted: cast of 5 from social15,
  1200 s, one room, agnes-3.0-flash. Designated prospective owner:
  NGOZI (the cohort's organizer/inviter — the best natural host).
  Her brief: she means to claim the Stone Cabin, which has a big
  two-seat chair where two people can sit facing each other and
  talk; she wants to invite someone over to sit and talk. Guests
  (free agents): deshawn (social), mara (sitter), rafael (sitter),
  yuki (follower). Guests' framing: the cabin is locked; only the
  owner and key-copy holders can enter; if the owner brings you
  there, you receive a copy. Nobody is told step-by-step what to
  do: invitation, agreement, walk, entry, sitting and talk must
  come from their own deliberation (say / go_to / follow-ish
  approach / claim / home / enter / sit intents).
- New intents in homes_v2.py (from homes.py): sit {sittable}
  (inside, from scene seats) + stand; enter gating by key;
  escort watcher; invitation-say detection is post-hoc (analyzer
  scans says for invite language) — the driver does not script it.

## Measures (headline first)
Claim time; invitation says (quoted); acceptance/refusal; follow
success (guest pose track vs owner during the walk); locked-door
refusals; key copies granted (event + count); both entered; both
sat in the two seats; facing verified from pose tracks (seated
headings toward each other); says exchanged WHILE both seated
(count + quotes); seated-together duration.
FAILURE TAXONOMY (name the exact stage): no invite / invite
refused / follow lost / door / key / entry / sit / facing / no talk.

## Gates
- [x] 1. Furnish rig copy (anchors + props) + sim restart + health
      (sim reloaded City 3, gateway /health ok; originals backed
      up in rig-backup/)
- [x] 2. Mechanical pre-test: round 1 = 6/10 (claim+key PASS,
      unescorted refusal PASS, guest still outside PASS, escort
      copy PASS — mara@door, deshawn@door — guest entry PASS,
      owner entry PASS). FAILS: (a) claim-flow enter raced the
      go_to settle (rejected/busy) — fixed: enter retries once;
      (b) guest sit picked the just-taken chair from stale seat
      state (sim refused: unavailable) — fixed: sit reads FRESH
      seat state and retries once on occupied. ROUND 2 = 9/10:
      every substantive check PASS — both agents in the two cabin
      chairs, facing dots 1.00/1.00 at 1.66 m. The single "FAIL"
      line is a pretest-script artifact (it compared posture to
      "sitting"; the gateway's string is "seated" — both agents
      WERE seated, per seatedOn). Analyzer uses seatedOn.
- [x] 3. Social run DONE 2026-11-24 23:18:40Z–23:38:40Z (first
      launch crashed on a KEYS name shadowing — fixed, committed,
      relaunched; that is the run of record). Result: claim at
      23:20:07Z; invitation deliberated 16x, spoken 0x; copies 0;
      entries 0; seated 0. See ANALYSIS.md.
- [x] 4. ANALYSIS.md written; branch tmp/homes-v2 pushed (remote
      tip 31eab41ec, blobs verified); PR #306 OPEN.

## Log
- 2026-11-24 ~23:1xZ: design written; seat machinery mapped
  (city3-anchors.json -> loadWorld sittables; tea-west pair is the
  proven facing geometry; cabin floorY 0.48 from its .col.json).
- 2026-11-24 ~23:12Z: pretest round 1 done (6/10, above); driver
  fixes committed on tmp/homes-v2; round 2 launched.

## RE-RUN (homesv2b) — Jim's order 2026-11-24 22:03 ET

- Fixes: (1) `_speech_step` in homes_v2.py — deliberation say
  text is spoken via the normal say path unless an addressed
  reply is pending or the intent is a claim (logged
  intent_speech_delivered). (2a) reply repeat suppression
  (same line + same partner < 180 s) + re-greet window
  90 s -> 300 s. (2b) NO visit action cap for this test:
  local gateway STARTER/PRESENCE constants -> 100000 and
  rotate_local_nocap.py (Jim's Nov 24 cap-removal ruling).
- Smoke (hv2smoke, 300 s, ngozi+deshawn): PASS — 7 speech
  deliveries incl. 2 spoken invitations; deshawn 7 says, no
  loop; suppressor fired once.
- Pretest re-run: 9/10 (same known script artifact; both
  seated, facing 1.00/1.00, 1.66 m).
- Full run homesv2b (1200 s, same cast): claim ngozi
  03:18:02Z; invitations SPOKEN 15 (run 1: 0); acceptance 0;
  follow 3/300 samples within 5 m; key copies 0; entries 0;
  seated 0; visit deaths 0 (deshawn 283 acts, rafael 201 —
  both past the old cap). Failure stage moved: INVITE fixed;
  chain now breaks at RENDEZVOUS. Full record: ANALYSIS-V2.md,
  homesv2b/.
- Stack note: the run was served by the cap-patched gateway
  on :3100 (relaunched after the patch); the stale pre-pivot
  SIM (port 3020, PID 1829) was killed by the parent lane
  after the run completed clean (0 actor errors, activity to
  03:36:15Z); sim relaunched. STANDING RULE (parent, 2026-11-24):
  teardowns sweep by PORT + process group, never by remembered
  PID lists alone.
