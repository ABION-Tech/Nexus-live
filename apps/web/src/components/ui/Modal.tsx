import { createPortal } from 'react-dom';
import { useEffect, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="nx-overlay" onClick={onClose}>
      <div className="nx-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="nx-modal__header">
            <h3>{title}</h3>
            <button className="nx-modal__close" onClick={onClose} aria-label="Close">×</button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
