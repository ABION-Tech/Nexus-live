import { useState } from 'react';
import { Card, Button, Badge, Tabs, DatePicker, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { generateAiReport } from '../../services/reportService';
import type { AiReportMode, AiReportResult } from '@nexus/shared';

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

const MODES: { key: AiReportMode; label: string }[] = [
  { key: 'attention', label: 'Attention Queue' },
  { key: 'predictions', label: 'Predictions' },
  { key: 'custom', label: 'Custom Report' },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

// PRD §7.2 08 AI ANALYST → Reports. Attention Queue / Predictions /
// Custom Report — all three call the same POST /ai/reports/generate,
// which narrates deterministic counts (blocked tasks, upcoming
// deadlines, stale partner follow-ups, and the task-trends window) —
// "AI narrates, doesn't invent" per PRD §8.8/Appendix C. Reports aren't
// persisted (PRD O7: no reports table exists yet) — each generate call
// is its own fresh snapshot, not a re-fetchable history.
export function Reports() {
  const { show } = useToast();
  const [mode, setMode] = useState<AiReportMode>('attention');
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(todayIso());
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [result, setResult] = useState<AiReportResult | null>(null);

  function handleGenerate() {
    setLoad({ status: 'loading' });
    generateAiReport(mode, mode === 'custom' ? from : undefined, mode === 'custom' ? to : undefined)
      .then((res) => {
        setResult(res);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
        show(message, 'danger');
      });
  }

  return (
    <div className="nx-page nx-view-enter">
      <h2>Reports</h2>

      <Tabs
        items={MODES.map((m) => ({ key: m.key, label: m.label }))}
        active={mode}
        onChange={(key) => {
          setMode(key as AiReportMode);
          setResult(null);
          setLoad({ status: 'idle' });
        }}
      />

      <Card className="nx-stack nx-stack--md">
        {mode === 'custom' && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <DatePicker label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
            <DatePicker label="To" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        <div>
          <Button onClick={handleGenerate} disabled={load.status === 'loading'}>
            {load.status === 'loading' ? 'Generating…' : 'Generate report'}
          </Button>
        </div>
      </Card>

      {load.status === 'loading' && <LoadingState label="NEXUS AI is analyzing…" />}
      {load.status === 'error' && (
        <ErrorState title="Couldn't generate the report" description={load.message} onRetry={handleGenerate} />
      )}
      {load.status === 'idle' && !result && (
        <EmptyState title="No report yet" description="Pick a mode above and generate a report." />
      )}

      {load.status === 'ready' && result && (
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone={result.signals.blockedCount > 0 ? 'danger' : 'success'}>
              {result.signals.blockedCount} blocked
            </Badge>
            <Badge tone={result.signals.upcomingDeadlineCount > 0 ? 'warning' : 'success'}>
              {result.signals.upcomingDeadlineCount} deadlines due
            </Badge>
            <Badge tone={result.signals.stalePartnerCount > 0 ? 'warning' : 'success'}>
              {result.signals.stalePartnerCount} stale partner follow-ups
            </Badge>
            <Badge tone="info">{result.signals.trendPoints.length} trend days</Badge>
          </div>
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{result.narrative}</p>
          <span style={{ fontSize: 12, opacity: 0.6 }}>
            Generated {new Date(result.generatedAt).toLocaleString()}
          </span>
        </Card>
      )}
    </div>
  );
}
