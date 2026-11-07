import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type ToastTone = 'default' | 'success' | 'danger';
interface ToastItem { id: number; message: string; tone: ToastTone; leaving: boolean; }

interface ToastContextValue {
  show: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// PRD §14 Toast — provider-based so any module can call useToast() without
// prop-drilling. Wrap the app once in main.tsx / App.tsx.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, tone: ToastTone = 'default') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, tone, leaving: false }]);
    // Two-phase removal: mark leaving (triggers the CSS exit transition
    // below) then actually drop it from state once that transition has
    // had time to finish. Matching the entrance (nx-toast-in) with a real
    // exit rather than an instant unmount was flagged as a real gap —
    // popping out abruptly read as unfinished next to the polished
    // entrance.
    setTimeout(() => {
      setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 200);
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {createPortal(
        <div className="nx-toast-region">
          {items.map((t) => (
            <div
              key={t.id}
              className={`nx-toast ${t.tone !== 'default' ? `nx-toast--${t.tone}` : ''} ${t.leaving ? 'nx-toast--leaving' : ''}`}
            >
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used within <ToastProvider>');
  return ctx;
}
