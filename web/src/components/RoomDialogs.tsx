import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { RpcError } from '../api/rpc';
import type { RoomDto } from '../api/types';

const MAX_MISSION_BYTES = 262_144;

export function CreateRoomDialog({ open, onClose, onCreate }: {
  open: boolean;
  onClose(): void;
  onCreate(goal: string, briefing: string): Promise<void>;
}) {
  const [goal, setGoal] = useState('');
  const [briefing, setBriefing] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);

  if (!open) return null;
  const goalError = missionError('Goal', goal);
  const briefingError = missionError('Briefing', briefing);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (goalError || briefingError || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate(goal.trim(), briefing.trim());
      setGoal('');
      setBriefing('');
    } catch (failure) {
      setError(failure instanceof RpcError && failure.outcomeUnknown
        ? `The create request did not receive a confirmation, so its outcome is unknown. Your fields are retained. ${failure.message}`
        : failure instanceof Error ? failure.message : 'Room creation failed.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create mission room" open={open} onClose={onClose} locked={submitting}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-intro">Define the shared objective. Invitation requirements are added after the room is created.</p>
        <MissionField label="Goal" value={goal} onChange={setGoal} error={goalError} rows={3} autoFocus />
        <MissionField label="Briefing" value={briefing} onChange={setBriefing} error={briefingError} rows={6} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting || Boolean(goalError || briefingError)}>{submitting ? 'Creating room…' : 'Create mission room'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsDialog({ room, open, onClose, onSave }: {
  room: RoomDto;
  open: boolean;
  onClose(): void;
  onSave(changes: { goal?: string; briefing?: string; status?: string }): Promise<void>;
}) {
  const [goal, setGoal] = useState(room.mission.goal);
  const [briefing, setBriefing] = useState(room.mission.briefing);
  const [status, setStatus] = useState(room.status ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);
  if (!open) return null;

  const goalError = missionError('Goal', goal);
  const briefingError = missionError('Briefing', briefing);
  const statusError = room.status && !status.trim() ? 'An existing status cannot be cleared.' : undefined;
  const changes: { goal?: string; briefing?: string; status?: string } = {};
  if (goal.trim() !== room.mission.goal) changes.goal = goal.trim();
  if (briefing.trim() !== room.mission.briefing) changes.briefing = briefing.trim();
  if (status.trim() !== (room.status ?? '')) changes.status = status.trim();
  const dirty = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || goalError || briefingError || statusError || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try { await onSave(changes); }
    catch (failure) {
      setError(failure instanceof RpcError && failure.outcomeUnknown
        ? `The settings request did not receive a confirmation, so its outcome is unknown. Your fields are retained. ${failure.message}`
        : failure instanceof Error ? failure.message : 'Settings update failed.');
    }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  return (
    <Modal title="Room settings" open={open} onClose={onClose} locked={submitting}>
      <form className="dialog-form" onSubmit={submit}>
        <MissionField label="Goal" value={goal} onChange={setGoal} error={goalError} rows={3} autoFocus />
        <MissionField label="Briefing" value={briefing} onChange={setBriefing} error={briefingError} rows={5} />
        <TextField label="Status (optional)" value={status} onChange={setStatus} error={statusError} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting || !dirty || Boolean(goalError || briefingError || statusError)}>{submitting ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}

function MissionField({ label, value, onChange, error, rows, autoFocus = false }: {
  label: string; value: string; onChange(value: string): void; error?: string; rows: number; autoFocus?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} value={value} rows={rows} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoFocus={autoFocus} data-autofocus={autoFocus ? 'true' : undefined} />{error ? <small id={errorId} className="field-error">{error}</small> : <small>{byteLength(value.trim())} / {MAX_MISSION_BYTES} bytes</small>}</div>;
}

function TextField({ label, value, onChange, error }: { label: string; value: string; onChange(value: string): void; error?: string }) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <small id={errorId} className="field-error">{error}</small>}</div>;
}

function Modal({ title, open, onClose, locked, children }: { title: string; open: boolean; onClose(): void; locked: boolean; children: ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  onCloseRef.current = onClose;
  lockedRef.current = locked;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const focusable = () => [...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    (focusable().find((element) => element.dataset.autofocus === 'true') ?? focusable()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lockedRef.current) { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const targets = focusable();
      if (!targets.length) return;
      const first = targets[0]!;
      const last = targets[targets.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (!locked && event.target === event.currentTarget) onClose(); }}><div ref={panelRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} disabled={locked} aria-label={`Close ${title}`}>×</button></header>{children}</div></div>;
}

function missionError(label: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (byteLength(trimmed) > MAX_MISSION_BYTES) return `${label} must be at most ${MAX_MISSION_BYTES} UTF-8 bytes.`;
  return undefined;
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
