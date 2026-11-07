import { useEffect, useState } from 'react';
import { Badge, Button, Card, LoadingState, ErrorState, useToast } from '../../components/ui';
import { fetchAutomationControls, toggleAutomationControl } from '../../services/automationService';
import type { AutomationControl } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; controls: AutomationControl[] };

// Group Admin > Operations — same underlying data as Automation >
// Automation Toggles (automationService.ts is already org-scoped by the
// session cookie, and a Group Admin's own org is the group), presented
// here as a lighter read-plus-toggle list rather than duplicating
// AutomationToggles.tsx's full per-job description panel. "Operations"
// per the guide's own §3 wording, distinct from Company Admin's
// "Automation" tab label — same data, section-appropriate naming.
export function GroupOperations() {
  const { show } = useToast();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchAutomationControls()
      .then((controls) => setState({ status: 'ready', controls }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  async function handleToggle(control: AutomationControl) {
    setTogglingKey(control.key);
    try {
      await toggleAutomationControl(control.key, !control.enabled);
      show(`${control.key} ${!control.enabled ? 'enabled' : 'disabled'}.`, 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not update.', 'danger');
    } finally {
      setTogglingKey(null);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading operations…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load operations" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Operations</h2>
      <div className="nx-stack nx-stack--sm">
        {state.controls.map((c) => (
          <Card key={c.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{c.key.replace(/_/g, ' ')}</div>
              <Badge tone={c.enabled ? 'success' : 'neutral'} dot>{c.enabled ? 'Enabled' : 'Disabled'}</Badge>
            </div>
            <Button
              size="sm"
              variant={c.enabled ? 'secondary' : 'primary'}
              disabled={togglingKey === c.key}
              onClick={() => handleToggle(c)}
            >
              {togglingKey === c.key ? 'Updating…' : c.enabled ? 'Disable' : 'Enable'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
