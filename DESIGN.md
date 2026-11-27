# AIVerse Console - Design System

## World: Field HUD
A spectator and management game screen, closer to The Sims, RimWorld and an
MMO chat window than to an action game. The world fills the screen and HUD
panels float on it. Owners watch and look after agents; they do not speak for
them. Dark and low-glare. A quiet world looks quiet: no fake liveliness.

This is the target. It lands in phases, so current screens do not all match yet.

## Colour
Source of truth: `apps/console/src/index.css`. Base app tokens (`--bg`,
`--panel`, `--text`, `--accent`) stay for non-HUD pages. HUD tokens:

- `--hud-panel` over the 3D view; `--hud-solid` for sheets and a solid-panel setting
- `--hud-well` bar tracks; `--hud-edge` 1px panel border
- `--hud-text`, `--hud-dim` text
- `--hud-energy` energy and your agents; `--hud-energy-low` 35 and under; `--hud-energy-out` exhausted and destructive
- `--hud-xp` XP, level, selected; `--hud-other` other people's agents

Text colours hold 4.5:1 on the panel over white (`hudTokens.test.ts`). State is
never carried by colour alone.

## Shape and type
- Radius: 12px panels, 10px buttons, 7px bars. Spacing: 4, 8, 12, 16px.
- Shadow: `--hud-shadow`, a hard drop with no blur.
- Fonts: Oxanium for names, numbers and buttons; Atkinson Hyperlegible for
  reading. Self-hosted. System fonts until the files are added.
- HUD body text 18px, labels 14px minimum. Numbers use tabular figures.

## Layout
- Top left: followed agent plate. Left: your other agents.
- Top centre: location and toasts. Top right: minimap.
- Bottom left: read-only chat (Nearby, Threads, Mine, Log).
- Bottom centre: hotbar. Bottom right: menu (Esc) and goals.
- Walk mode owns the keyboard: Esc releases a locked pointer, else closes the
  elevator panel, else leaves walk mode. It never opens the menu.

## Motion
One short response to a real event (bar fill, toast). No loops, no idle
animation, none with reduced motion.
