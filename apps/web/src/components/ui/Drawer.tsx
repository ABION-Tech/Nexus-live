import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, children }: DrawerProps) {
  if (!open) return null;
  return createPortal(
    <div className="nx-overlay" onClick={onClose}>
      <div className="nx-drawer" onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="nx-drawer__header">
            <h3>{title}</h3>
            <button className="nx-drawer__close" onClick={onClose} aria-label="Close">×</button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
