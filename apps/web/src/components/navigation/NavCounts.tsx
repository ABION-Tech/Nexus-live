// Session 58 — live counts for the sidebar badges (Master Tasks 27,
// Follow-Ups 31, Failsafe 28 …), as in the original HTML app. Refreshed
// every minute and when you move between pages (at most every 15s).
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchOverview, type OverviewCounts } from '../../services/overviewService';

const Ctx = createContext<OverviewCounts | null>(null);

export function NavCountsProvider({ children }: { children: ReactNode }) {
  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const last = useRef(0);
  const { pathname } = useLocation();

  useEffect(() => {
    const load = (force = false) => {
      if (!force && Date.now() - last.current < 15_000) return;
      last.current = Date.now();
      fetchOverview(1)
        .then((o) => setCounts(o.counts))
        .catch(() => undefined);
    };
    load();
    const t = window.setInterval(() => load(true), 60_000);
    const onChange = () => load(true);
    window.addEventListener('nx:data-changed', onChange);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('nx:data-changed', onChange);
    };
  }, [pathname]);

  return <Ctx.Provider value={counts}>{children}</Ctx.Provider>;
}

export const useNavCounts = () => useContext(Ctx);
