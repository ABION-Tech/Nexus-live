// Session 58 — the top bar's "+ Task / + Partner / + Content …" button,
// as in the original HTML app. The bar fires `nx:quick-add`; the page on
// screen opens its own create form. Arriving at a page with ?new=1 (the
// button used on a page with nothing to create) does the same.
import { useEffect } from 'react';

export const QUICK_ADD_EVENT = 'nx:quick-add';

export function useQuickAdd(open: () => void) {
  useEffect(() => {
    const handler = () => open();
    window.addEventListener(QUICK_ADD_EVENT, handler);
    const url = new URL(window.location.href);
    if (url.searchParams.get('new') === '1') {
      url.searchParams.delete('new');
      window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
      open();
    }
    return () => window.removeEventListener(QUICK_ADD_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Tell the shell something changed (counts refresh straight away). */
export const dataChanged = () => window.dispatchEvent(new Event('nx:data-changed'));
