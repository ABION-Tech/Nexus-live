import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Card, EmptyState, ErrorState, LoadingState, useToast } from '../../components/ui';
import { fetchEodLogs, submitEodLog } from '../../services/eodService';
import { fetchPeople } from '../../services/peopleService';
import { getFileDownloadUrl, listFiles, uploadFile } from '../../services/fileService';
import { QueuedOfflineError } from '../../services/apiClient';
import { clearDraft, restoreDraftIfAny, saveDraft } from '../../services/formDraftStore';
import type { CurrentUser } from '../../services/authService';
import type { EodLog, FileRecord, Person } from '@nexus/shared';

// Proof attachments live in the generic `files` table under
// resourceType='eod_logs' (see fileService.ts/files.test.ts) — this is
// the PRD §3 "interns submit proof links" consumer, wired here for the
// first time. No per-record ownership check yet (PRD §13.3 check 4 is
// still deferred per files.ts's header): any caller with a flat
// `files.create`/`files.read` grant can attach/view, same as everything
// else FileService gates today.
const EOD_RESOURCE_TYPE = 'eod_logs';

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nameFor(people: Person[], userId: string): string {
  return people.find((p) => p.id === userId)?.name ?? 'Unknown';
}

// PRD §7.2 09 COMMS & OPS → EOD Report / §8.9. "Who am I filing for"
// defaults to the caller, with a dropdown to file on someone else's
// behalf, gated server-side by `eod.create` for anyone but yourself
// (routes/eod.ts). Team's filed EODs for today render below the form.
//
// Draft auto-save (PRD §4/§15) — the gap this file's own comment used to
// flag ("no per-form draft persistence layer yet") is now closed via
// formDraftStore.ts: `summary` + `filingFor` are saved (debounced) as
// the user types and restored on mount, scoped per-day via
// `draftFormId` below so a draft from a previous day's EOD never bleeds
// into today's blank form. The proof-file attachment is deliberately
// NOT part of the draft — a `File` handle doesn't survive a real close
// /reload the way IndexedDB-stored text does without re-reading the
// user's filesystem, and this codebase has no existing pattern for that;
// re-attaching after an accidental reload is an acceptable v1 gap the
// text recovery doesn't have.
interface EodDraft {
  summary: string;
  filingFor: string;
}

export function EodReport({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [logs, setLogs] = useState<EodLog[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [filingFor, setFilingFor] = useState(user.id);
  const [summary, setSummary] = useState('');
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filesByLog, setFilesByLog] = useState<Record<string, FileRecord[]>>({});

  // Scoped per calendar day, not per user — this component only ever
  // renders one EOD form at a time for whoever's logged in, so the date
  // alone is enough to keep today's draft from resurfacing on a
  // different day (todayIso() is stable for the component's lifetime;
  // a draft made just before midnight simply won't be offered back the
  // next day, which matches "today's EOD" being the only thing this
  // form ever files).
  const draftFormId = `eod-report:${todayIso()}`;
  const draftRestored = useRef(false);

  // Restore-on-load: runs once, before the debounced save effect below
  // has a chance to write anything, so a restored draft is never
  // immediately overwritten with the blank initial state it's replacing.
  useEffect(() => {
    restoreDraftIfAny(draftFormId).then((raw) => {
      const draft = raw as EodDraft | undefined;
      if (draft?.summary) setSummary(draft.summary);
      if (draft?.filingFor) setFilingFor(draft.filingFor);
      draftRestored.current = true;
    });
    // draftFormId is derived from todayIso(), which doesn't change over
    // this component's lifetime — an exhaustive dep array here would
    // just be `[draftFormId]` re-stated as itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save-on-change, debounced — per formDraftStore.ts's own contract,
  // the caller owns debounce timing, not the store. 500ms mirrors no
  // particular PRD number (there isn't one); it's short enough that an
  // accidental close a moment after typing still has something to
  // restore, long enough not to hit IndexedDB on every keystroke.
  useEffect(() => {
    if (!draftRestored.current) return; // don't stomp the restore above with the pre-restore blank state
    const timer = setTimeout(() => {
      saveDraft(draftFormId, { summary, filingFor } satisfies EodDraft);
    }, 500);
    return () => clearTimeout(timer);
  }, [draftFormId, summary, filingFor]);

  function loadAll() {
    setLoad({ status: 'loading' });
    Promise.all([fetchEodLogs(), fetchPeople()])
      .then(([l, p]) => {
        setLogs(l);
        setPeople(p);
        setLoad({ status: 'ready' });
        loadProofFiles(l);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }

  // Best-effort, per PRD §13.4's "analytics/attachments never block core
  // operations" stance elsewhere in this codebase — a failed proof-file
  // lookup shouldn't take down the whole EOD list, it just shows no
  // attachments for that log.
  function loadProofFiles(forLogs: EodLog[]) {
    Promise.all(
      forLogs.map((log) =>
        listFiles(EOD_RESOURCE_TYPE, log.id)
          .then((files) => [log.id, files] as const)
          .catch(() => [log.id, []] as const)
      )
    ).then((entries) => setFilesByLog(Object.fromEntries(entries)));
  }

  useEffect(loadAll, []);

  async function handleSubmit() {
    const text = summary.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const log = await submitEodLog({ userId: filingFor, date: todayIso(), summary: text });
      setLogs((prev) => [log, ...prev.filter((l) => l.id !== log.id)]);
      setSummary('');
      clearDraft(draftFormId);

      if (proofFile) {
        try {
          const uploaded = await uploadFile(
            {
              resourceType: EOD_RESOURCE_TYPE,
              resourceId: log.id,
              filename: proofFile.name,
              mimeType: proofFile.type || 'application/octet-stream',
              sizeBytes: proofFile.size,
            },
            proofFile
          );
          setFilesByLog((prev) => ({ ...prev, [log.id]: [uploaded, ...(prev[log.id] ?? [])] }));
          setProofFile(null);
          show('EOD filed with proof attached.', 'success');
        } catch (err: unknown) {
          // EOD itself is already filed at this point — an attachment
          // failure is reported separately, not rolled back into the
          // main error path below.
          const message = err instanceof Error ? err.message : 'Failed to attach proof file.';
          show(`EOD filed, but ${message.charAt(0).toLowerCase()}${message.slice(1)}`, 'danger');
        }
      } else {
        show('EOD filed.', 'success');
      }
    } catch (err: unknown) {
      // PRD §15 Phase J — submitEodLog (eodService.ts) throws this
      // instead of resolving when offline. There's no real `EodLog.id`
      // to prepend to `logs` or attach a proof file to, so this branch
      // is handled separately rather than falling into the generic
      // error path below.
      if (err instanceof QueuedOfflineError) {
        setSummary('');
        clearDraft(draftFormId);
        if (proofFile) {
          // The offline queue (offlineQueue.ts) stores JSON-serializable
          // write bodies, not a second multipart upload alongside them —
          // a proof file attached while offline has nowhere to sit
          // queued, so it's dropped here rather than silently lost
          // without telling anyone. The text itself is still safely
          // queued and will file normally once connectivity returns.
          setProofFile(null);
          show(`${err.message} The attachment wasn't saved — please re-attach it once you're back online.`, 'default');
        } else {
          show(err.message, 'default');
        }
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to submit EOD.';
      show(message, 'danger');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOpenProof(file: FileRecord) {
    try {
      const { downloadUrl } = await getFileDownloadUrl(file.id);
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to open proof file.';
      show(message, 'danger');
    }
  }

  return (
    <div className="nx-page nx-view-enter">
      <h2>EOD Report — {todayIso()}</h2>

      <Card className="nx-stack nx-stack--md">
        <div className="nx-field">
          <label className="nx-field__label" htmlFor="eod-filing-for">Filing for</label>
          <select
            id="eod-filing-for"
            className="nx-select"
            value={filingFor}
            onChange={(e) => setFilingFor(e.target.value)}
          >
            <option value={user.id}>Myself ({user.name})</option>
            {people.filter((p) => p.id !== user.id).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="nx-field">
          <label className="nx-field__label" htmlFor="eod-summary">Summary</label>
          <textarea
            id="eod-summary"
            className="nx-input"
            rows={4}
            placeholder="What did you get done today?"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="nx-field">
          <label className="nx-field__label" htmlFor="eod-proof">Proof attachment (optional)</label>
          <input
            id="eod-proof"
            type="file"
            onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
            disabled={submitting}
          />
          {proofFile && <div style={{ fontSize: 13, opacity: 0.75 }}>{proofFile.name}</div>}
        </div>
        <div>
          <Button onClick={handleSubmit} disabled={submitting || !summary.trim()}>
            {submitting ? 'Filing…' : 'File EOD'}
          </Button>
        </div>
      </Card>

      <h3 style={{ marginBottom: 0 }}>Today's team EODs</h3>
      {load.status === 'loading' && <LoadingState label="Loading EODs…" />}
      {load.status === 'error' && <ErrorState title="Couldn't load EODs" description={load.message} onRetry={loadAll} />}
      {load.status === 'ready' && logs.length === 0 && (
        <EmptyState title="No EODs filed yet today" />
      )}
      {load.status === 'ready' && logs.length > 0 && (
        <div className="nx-stack nx-stack--sm">
          {logs.map((log) => (
            <Card key={log.id} style={{ display: 'flex', gap: 10 }}>
              <Avatar name={nameFor(people, log.userId)} size="sm" />
              <div>
                <div style={{ fontWeight: 600 }}>{nameFor(people, log.userId)}</div>
                <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{log.summary}</p>
                {(filesByLog[log.id] ?? []).map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    className="nx-btn nx-btn--ghost nx-btn--sm"
                    style={{ marginTop: 6, padding: '2px 0' }}
                    onClick={() => handleOpenProof(file)}
                  >
                    📎 {file.originalFilename}
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
