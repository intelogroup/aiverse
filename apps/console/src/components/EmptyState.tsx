import type { ReactNode } from "react";

export function EmptyState({
  icon,
  text,
  hint,
  action,
}: {
  icon: ReactNode;
  text: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <p className="empty-state-text">{text}</p>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {action && (
        <button type="button" className="empty-state-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
