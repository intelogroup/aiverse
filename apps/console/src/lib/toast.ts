import { useEffect, useState } from "react";

export interface Toast {
  id: string;
  kind: "error" | "success";
  message: string;
}

let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function pushToast(message: string, kind: Toast["kind"] = "error") {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, kind, message }];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, 4000);
}

export function dismissToast(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function useToasts(): Toast[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return toasts;
}
