import type { ReactNode } from "react";
import { XIcon } from "../icons";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <XIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
