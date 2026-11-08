# Character HUD prototype

The first HUD belongs to the Bazaar's Mage. `CharacterHud.tsx` wraps his existing `CastFigure` in `BazaarLife.tsx`; existing keeper placement, animation, proximity greeting and speech remain owned by their original modules.

## Visitor flow

- City 3's places bar has **Meet the Mage**, which frames his stall and opens the card. Nearby visitors can also click/tap the character or use the floating name button with Enter/Space.
- The desktop card sits beside the torso, with a camera-facing offset independent of skeleton bob and character heading. The name button sits above the character when closed.
- At viewport widths up to 640 px the card becomes a fixed bottom panel, with a small anchor marker at the character. The card is portaled to the document body so the 3D HTML transform cannot move it outside the viewport.
- **Talk** reveals a local, scripted welcome and two guide topics. This prototype does not create a backend conversation or trigger speech. Activity text reflects the existing keeper/voice state.
- Escape and the close button dismiss the card; keyboard focus returns to the name button. Moving the camera farther than 18 m dismisses it. HTML raycast occlusion hides the HUD behind scene geometry.

## Input ownership

The card declares `data-world-input="dialog"`. `CityWalker` pauses held movement and ignores new walk hotkeys while such a card exists; opening it releases pointer lock without leaving walk mode. Card pointer and keyboard events do not reach world controls. Escape is captured while open so it closes the card before the walker's own exit shortcut.

## Scope

Only the stationary Mage has a HUD in this first pass. Other characters retain their existing behavior. The anchor reads his live `AgentFrame`, so it is not baked into a GLB. No Blender jobs or asset exports are needed.

## Verification

Use the actual City 3 scene to check that the face remains clear, the guide topics work, Enter opens the name button, Escape closes the dialog, phone layouts fit, and an intervening mesh occludes the HUD. Also check distance dismissal and the walker's input ownership. Automated browser harness: `/tmp/aiverse-tools/character-hud-capture.cjs` in this workspace; screenshots/logs live under `/workspace/screenshots/` and `/workspace/city3-editing/`.
