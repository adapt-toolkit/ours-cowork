import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { RpcError } from '../api/rpc';
import type { RoomDto } from '../api/types';

const MAX_MISSION_BYTES = 262_144;

export function CreateRoomDialog({ open, restoreFocus, fallbackFocus, onClose, onCreate }: {
  open: boolean;
  restoreFocus?: HTMLElement;
  fallbackFocus?(): HTMLElement | undefined;
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
    <Modal title="Create mission room" open={open} restoreFocus={restoreFocus} fallbackFocus={fallbackFocus} onClose={onClose} locked={submitting}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-intro">Define the shared objective. Invitation requirements are added after the room is created.</p>
        <MissionField label="Goal" value={goal} onChange={setGoal} error={goalError} rows={3} autoFocus trimForBytes />
        <MissionField label="Briefing" value={briefing} onChange={setBriefing} error={briefingError} rows={6} trimForBytes />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={submitting || Boolean(goalError || briefingError)}>{submitting ? 'Creating room…' : 'Create mission room'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsDialog({ room, open, restoreFocus, onClose, onSave }: {
  room: RoomDto;
  open: boolean;
  restoreFocus?: HTMLElement;
  onClose(): void;
  onSave(changes: { goal?: string; briefing?: string; status?: string }): Promise<void>;
}) {
  const [goal, setGoal] = useState(room.mission.goal);
  const [briefing, setBriefing] = useState(room.mission.briefing);
  const [status, setStatus] = useState(room.status ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    setGoal(room.mission.goal);
    setBriefing(room.mission.briefing);
    setStatus(room.status ?? '');
    setError(undefined);
  }, [open, room.mission.briefing, room.mission.goal, room.room_id, room.status]);
  if (!open) return null;

  const goalError = exactMissionError('Goal', goal);
  const briefingError = exactMissionError('Briefing', briefing);
  const statusError = room.status && !status ? 'An existing status cannot be cleared.' : undefined;
  const changes: { goal?: string; briefing?: string; status?: string } = {};
  if (goal !== room.mission.goal) changes.goal = goal;
  if (briefing !== room.mission.briefing) changes.briefing = briefing;
  if (status !== (room.status ?? '')) changes.status = status;
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
    <Modal title="Room settings" open={open} restoreFocus={restoreFocus} onClose={onClose} locked={submitting}>
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

function MissionField({ label, value, onChange, error, rows, autoFocus = false, trimForBytes = false }: {
  label: string; value: string; onChange(value: string): void; error?: string; rows: number; autoFocus?: boolean; trimForBytes?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} value={value} rows={rows} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoFocus={autoFocus} data-autofocus={autoFocus ? 'true' : undefined} />{error ? <small id={errorId} className="field-error">{error}</small> : <small>{byteLength(trimForBytes ? value.trim() : value)} / {MAX_MISSION_BYTES} bytes</small>}</div>;
}

function TextField({ label, value, onChange, error }: { label: string; value: string; onChange(value: string): void; error?: string }) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <small id={errorId} className="field-error">{error}</small>}</div>;
}

export function Modal({ title, open, restoreFocus, fallbackFocus, onClose, locked, children }: { title: string; open: boolean; restoreFocus?: HTMLElement; fallbackFocus?(): HTMLElement | undefined; onClose(): void; locked: boolean; children: ReactNode }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  onCloseRef.current = onClose;
  lockedRef.current = locked;
  useEffect(() => {
    if (!open) return;
    const previous = restoreFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
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
      if (!targets.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      const target = visibleRestoreTarget(previous) ? previous : fallbackFocus?.() ?? document.querySelector<HTMLElement>('[data-modal-fallback="true"]');
      if (visibleRestoreTarget(target)) target.focus();
    };
  }, [fallbackFocus, open, restoreFocus]);

  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (!locked && event.target === event.currentTarget) onClose(); }}><div ref={panelRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><h2 id={titleId}>{title}</h2><button className="icon-button" type="button" onClick={onClose} disabled={locked} aria-label={`Close ${title}`}>×</button></header>{children}</div></div>, document.body);
}

function missionError(label: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (byteLength(trimmed) > MAX_MISSION_BYTES) return `${label} must be at most ${MAX_MISSION_BYTES} UTF-8 bytes.`;
  return undefined;
}

function exactMissionError(label: string, value: string): string | undefined {
  if (byteLength(value) < 1) return `${label} is required.`;
  if (byteLength(value) > MAX_MISSION_BYTES) return `${label} must be at most ${MAX_MISSION_BYTES} UTF-8 bytes.`;
  return undefined;
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

function visibleRestoreTarget(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element?.isConnected
    && !element.matches(':disabled, [aria-disabled="true"]')
    && !element.closest('[hidden], [aria-hidden="true"]'));
}
