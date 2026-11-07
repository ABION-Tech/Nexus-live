import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LoadingState, ErrorState } from '../../components/ui';
import { MetricCard } from '../../components/dashboard';
import { fetchNetworkCos, fetchPartnerships, fetchOrgContacts } from '../../services/networkService';

interface NetworkCounts {
  cos: number;
  partnerships: number;
  orgContacts: number;
}

function loadCounts(): Promise<NetworkCounts> {
  return Promise.all([fetchNetworkCos(), fetchPartnerships(), fetchOrgContacts()]).then(([cos, partnerships, orgContacts]) => ({
    cos: cos.length,
    partnerships: partnerships.length,
    orgContacts: orgContacts.length,
  }));
}

// PRD §7.2 03 NETWORK → Overview. Landing page for the section — a count
// per subsection plus a link into each, same role §2.1's Dashboard
// Overview plays for Work. Each count is a real API call (three of the
// backend's own list endpoints), not a separate summary endpoint — v1
// scope, revisit if this section grows enough that three list calls on
// every Overview visit stops being cheap.
export function Overview() {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; counts: NetworkCounts }
  >({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    loadCounts()
      .then((counts) => setState({ status: 'ready', counts }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setState({ status: 'error', message });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading network…" />;
  if (state.status === 'error') {
    return <ErrorState title="Couldn't load network" description={state.message} onRetry={load} />;
  }

  const { counts } = state;

  return (
    <div className="nx-dashboard-overview">
      <h1>Network</h1>
      <div className="nx-dashboard-overview__metrics">
        <Link to="/network/state" className="nx-plain-link">
          <MetricCard label="State contacts" value={counts.cos} />
        </Link>
        <Link to="/network/partnerships" className="nx-plain-link">
          <MetricCard label="Partnerships" value={counts.partnerships} />
        </Link>
        <Link to="/network/org-database" className="nx-plain-link">
          <MetricCard label="Org contacts" value={counts.orgContacts} />
        </Link>
      </div>
    </div>
  );
}
