// hudBridge.ts — the HUD (rendered by WorldView) and the world state it needs (follow,
// walk mode, stream roster, say lines, all inside GlbWorld). Same shape as mobileShell.ts.
import type { SayLine } from "../remoteFrames";

export interface HudStage {
  walking: boolean;
  following: boolean;
  /** The owned agent the follow camera would use now. */
  followName: string | null;
  /** Names of every body in the stream. */
  present: readonly string[];
  says: readonly SayLine[];
}

export interface HudActions {
  follow: (name: string) => void;
  toggleFollow: () => void;
  walk: () => void;
  /** The GlbWorld element holding the canvas (Record and Share read it). */
  root: { current: HTMLDivElement | null };
}

export const IDLE_STAGE: HudStage = { walking: false, following: false, followName: null, present: [], says: [] };

interface Snapshot { stage: HudStage; actions: HudActions | null }

let snapshot: Snapshot = { stage: IDLE_STAGE, actions: null };
const listeners = new Set<() => void>();

function emit(next: Snapshot) {
  snapshot = next;
  for (const fn of listeners) fn();
}

const same = (a: HudStage, b: HudStage) =>
  a.walking === b.walking &&
  a.following === b.following &&
  a.followName === b.followName &&
  a.says === b.says &&
  a.present.join("\u0000") === b.present.join("\u0000");

export const hudBridge = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: (): Snapshot => snapshot,
  publish(stage: HudStage): void {
    if (!same(snapshot.stage, stage)) emit({ ...snapshot, stage });
  },
  /** Returns the unregister function. */
  register(actions: HudActions): () => void {
    emit({ ...snapshot, actions });
    return () => emit({ stage: IDLE_STAGE, actions: null });
  },
};
