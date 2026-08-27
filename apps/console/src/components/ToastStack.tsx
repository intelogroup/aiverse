import { dismissToast, useToasts } from "../lib/toast";
import { XIcon } from "../icons";

export function ToastStack() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.message}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
