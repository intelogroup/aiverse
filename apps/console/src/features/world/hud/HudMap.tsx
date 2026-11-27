// Location strip (top centre) and minimap (top right). Both read positions from the world on
// a timer, so the rest of the HUD does not re-render as agents move.
import { useEffect, useState } from "react";
import { onlineLabel } from "../worldLabels";
import type { HudActions } from "./hudBridge";
import { nearestPlace, useMapData } from "./places";

/** Well under the 1 s lag the minimap is allowed, on top of the stream's 0.2 s render delay. */
export const MAP_POLL_MS = 400;

/** City bounds in world metres, a little wider than the outermost places. North (-z) is up. */
const VIEW = "-110 -190 270 425";

interface Dot { name: string; x: number; z: number }
interface Where { bodies: Dot[]; focus: { x: number; z: number } | null }

export function HudMap({
  actions,
  owned,
  followName,
  following,
  walking,
  online,
  feedDown,
  onRetry,
  large,
  onToggle,
}: {
  actions: HudActions | null;
  owned: ReadonlySet<string>;
  followName: string | null;
  following: boolean;
  walking: boolean;
  online: number;
  feedDown: boolean;
  onRetry: () => void;
  large: boolean;
  onToggle: () => void;
}) {
  const [where, setWhere] = useState<Where>({ bodies: [], focus: null });
  useEffect(() => {
    if (!actions) return;
    const read = () => setWhere({ bodies: actions.bodies(), focus: actions.focus() });
    read();
    const id = window.setInterval(read, MAP_POLL_MS);
    return () => window.clearInterval(id);
  }, [actions]);
  const { named, stalls, rooms } = useMapData();

  const followed = following && followName ? where.bodies.find((b) => b.name === followName) : undefined;
  const spot = followed ?? where.focus;
  const near = spot ? nearestPlace(named, spot.x, spot.z) : null;
  const who = walking ? "Walking" : following && followName ? `Following ${followName}` : "Overview";

  return (
    <>
      <div className="hud-panel hud-strip" role="status">
        <span>{who}</span>
        {near ? <small>near {near.name}</small> : null}
        {feedDown ? (
          <span className="hud-stale">
            Can't reach the verse{" "}
            <button type="button" className="hud-btn" onClick={onRetry}>
              Retry now
            </button>
          </span>
        ) : null}
      </div>
      <section className={large ? "hud-panel hud-map large" : "hud-panel hud-map"} aria-label="Map">
        <button type="button" aria-pressed={large} aria-label={large ? "Shrink map" : "Enlarge map"} onClick={onToggle}>
          <svg viewBox={VIEW} role="img" aria-label={`${where.bodies.length} agents on the map`}>
            {rooms.map((r) => (
              <rect key={r.id} className="room" x={r.rect[0]} y={r.rect[1]} width={r.rect[2] - r.rect[0]} height={r.rect[3] - r.rect[1]} />
            ))}
            {stalls.map((s, i) => (
              <rect key={i} className="stall" x={s.x - 2} y={s.z - 2} width={4} height={4} />
            ))}
            {where.bodies.map((b, i) => (
              <circle key={`${b.name}-${i}`} className={owned.has(b.name) ? "mine" : "other"} cx={b.x} cy={b.z} r={owned.has(b.name) ? 7 : 5} data-name={b.name}>
                <title>{b.name}</title>
              </circle>
            ))}
          </svg>
        </button>
        <small>{near ? near.name : "Open ground"}</small>
        <small>{onlineLabel(online)}</small>
      </section>
    </>
  );
}
