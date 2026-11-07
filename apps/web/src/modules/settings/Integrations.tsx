import { useEffect, useState } from 'react';
import { Card, Button, Input, Select, LoadingState, ErrorState, useToast } from '../../components/ui';
import { fetchAiSettings, saveAiSettings, testAiConnection } from '../../services/aiSettingsService';
import { AI_MODEL_OPTIONS, DEFAULT_AI_MODEL } from '@nexus/shared';
import type { AiSettings, AiTestResult, AiTestTarget } from '@nexus/shared';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

const MODEL_OPTIONS = AI_MODEL_OPTIONS.map((m) => ({ value: m, label: m }));

// Settings > Integrations (PRD §7.2 11 SETTINGS) — the org's AI provider
// connection. Deliberately vendor-neutral: any OpenAI-compatible base URL
// works (NVIDIA NIM, a self-hosted endpoint, etc.), never a hardcoded
// vendor picker. Built entirely from the existing design system
// (Card/Input/Select/Button + nx-field/var(--surface)/var(--border) CSS
// tokens) so it inherits the app's palette by construction rather than
// by copying hex values here.
export function Integrations() {
  const { show } = useToast();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [settings, setSettings] = useState<AiSettings | null>(null);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [chatModel, setChatModel] = useState<string>(DEFAULT_AI_MODEL);
  const [reportModel, setReportModel] = useState('');
  const [meetingSecret, setMeetingSecret] = useState('');
  const [showMeetingSecret, setShowMeetingSecret] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testTarget, setTestTarget] = useState<AiTestTarget>('chat');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AiTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setState({ status: 'loading' });
    fetchAiSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.baseUrl ?? '');
        setChatModel(s.chatModel || DEFAULT_AI_MODEL);
        setReportModel(s.reportModel ?? '');
        setState({ status: 'ready' });
      })
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  async function handleSave() {
    setSaving(true);
    setTestResult(null);
    try {
      const saved = await saveAiSettings({
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        chatModel,
        reportModel: reportModel.trim() || undefined,
        meetingIngestSecret: meetingSecret.trim() || undefined,
      });
      setSettings(saved);
      setApiKey('');
      setMeetingSecret('');
      setShowApiKey(false);
      setShowMeetingSecret(false);
      show('AI settings saved.', 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Save failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testAiConnection(testTarget);
      setTestResult(result);
      if (!result.ok) show(`Test failed: ${result.message}`, 'danger');
      else show('Connection works.', 'success');
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Test failed.', 'danger');
    } finally {
      setTesting(false);
    }
  }

  if (state.status === 'loading') return <LoadingState label="Loading AI settings…" />;
  if (state.status === 'error') {
    return <ErrorState title="Couldn't load AI settings" description={state.message} onRetry={load} />;
  }

  return (
    <div className="nx-page nx-page--narrow nx-view-enter" style={{ maxWidth: 640 }}>
      <div>
        <h2>AI Settings</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          NVIDIA NIM (or other OpenAI-compatible) connection — used by @AI, the Attention Queue, and Predictions.
        </p>
      </div>

      <Card style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input
          label="API Base URL"
          placeholder="https://integrate.api.nvidia.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />

        <div>
          <Input
            label="API Key"
            type={showApiKey ? 'text' : 'password'}
            placeholder={settings?.hasApiKey ? '••••••••••••' : 'Enter API key'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {settings?.hasApiKey ? 'A key is currently saved — leave blank to keep it.' : 'No key saved yet.'}
            </span>
            <button
              type="button"
              onClick={() => setShowApiKey((v) => !v)}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <Select
          label="Chat Model — @AI, Attention Queue, Predictions"
          options={MODEL_OPTIONS}
          value={chatModel}
          onChange={(e) => setChatModel(e.target.value)}
        />

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: 13,
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {advancedOpen ? '▾' : '▸'} Advanced (report model, test, meeting ingest)
          </button>
        </div>

        {advancedOpen && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              paddingTop: 4,
              borderTop: '1px solid var(--border)',
            }}
          >
            <Select
              label="Report Model — optional, reused Chat Model if blank"
              options={[{ value: '', label: `(use Chat Model — ${chatModel})` }, ...MODEL_OPTIONS]}
              value={reportModel}
              onChange={(e) => setReportModel(e.target.value)}
            />

            <div>
              <span className="nx-field__label" style={{ display: 'block', marginBottom: 6 }}>
                Test which model?
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  variant={testTarget === 'chat' ? 'primary' : 'secondary'}
                  onClick={() => setTestTarget('chat')}
                >
                  Chat Model
                </Button>
                <Button
                  size="sm"
                  variant={testTarget === 'report' ? 'primary' : 'secondary'}
                  onClick={() => setTestTarget('report')}
                >
                  Report Model
                </Button>
                <Button size="sm" variant="ghost" onClick={handleTest} disabled={testing}>
                  {testing ? 'Testing…' : 'Test'}
                </Button>
              </div>
              {testResult && (
                <p style={{ fontSize: 12, marginTop: 8, color: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                  {testResult.ok ? '✓' : '✗'} {testResult.model}: {testResult.message}
                </p>
              )}
            </div>

            <div>
              <Input
                label="Meeting Ingest Secret — n8n's Fireflies → NEXUS webhook"
                type={showMeetingSecret ? 'text' : 'password'}
                placeholder={settings?.hasMeetingIngestSecret ? '••••••••••••' : 'Enter shared secret'}
                value={meetingSecret}
                onChange={(e) => setMeetingSecret(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {settings?.hasMeetingIngestSecret
                    ? "A secret is currently saved — leave blank to keep it. Give n8n's HTTP node this same value."
                    : "Give n8n's HTTP node this same value."}
                </span>
                <button
                  type="button"
                  onClick={() => setShowMeetingSecret((v) => !v)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }}
                >
                  {showMeetingSecret ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
