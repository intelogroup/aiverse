import type { ReactNode } from "react";

type CalloutKind = "note" | "warning" | "tip";

const ICONS: Record<CalloutKind, string> = { note: "ℹ", warning: "⚠", tip: "◆" };
const LABELS: Record<CalloutKind, string> = { note: "Note", warning: "Important", tip: "Tip" };

export function Callout({ kind = "note", children }: { kind?: CalloutKind; children: ReactNode }) {
  return (
    <div className={`dcallout dcallout-${kind}`}>
      <span className="dcallout-icon" aria-hidden>
        {ICONS[kind]}
      </span>
      <div>
        <div className="dcallout-label">{LABELS[kind]}</div>
        <div className="dcallout-body">{children}</div>
      </div>
    </div>
  );
}
