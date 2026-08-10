import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { RpcError } from '../api/rpc';
import type { RoomDto } from '../api/types';
import { normalizeRoomName, roomNameError } from '../roomName';
import { roomTitle } from './RoomRail';

const MAX_MISSION_BYTES = 262_144;

export function CreateRoomDialog({ open, connected, restoreFocus, fallbackFocus, onClose, onCreate }: {
  open: boolean;
  connected: boolean;
  restoreFocus?: HTMLElement;
  fallbackFocus?(): HTMLElement | undefined;
  onClose(): void;
  onCreate(name: string, goal: string, briefing: string): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [briefing, setBriefing] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);

  if (!open) return null;
  const nameError = roomNameError(name);
  const goalError = missionError('Goal', goal);
  const briefingError = missionError('Briefing', briefing);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connected || nameError || goalError || briefingError || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate(normalizeRoomName(name), goal.trim(), briefing.trim());
      setName('');
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
        <TextField label="Name" value={name} onChange={setName} error={nameError} autoFocus />
        <MissionField label="Goal" value={goal} onChange={setGoal} error={goalError} rows={3} trimForBytes />
        <MissionField label="Briefing" value={briefing} onChange={setBriefing} error={briefingError} rows={6} trimForBytes />
        {!connected && <p className="form-error" role="status">Create is unavailable because the daemon disconnected. Your fields are retained and no request was sent.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={!connected || submitting || Boolean(nameError || goalError || briefingError)}>{submitting ? 'Creating room…' : 'Create mission room'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function SettingsDialog({ room, open, connected, capable, restoreFocus, onClose, onSave }: {
  room: RoomDto;
  open: boolean;
  connected: boolean;
  capable: boolean;
  restoreFocus?: HTMLElement;
  onClose(): void;
  onSave(changes: { name?: string; goal?: string; briefing?: string; status?: string }): Promise<void>;
}) {
  const [name, setName] = useState(room.room_name);
  const [goal, setGoal] = useState(room.mission.goal);
  const [briefing, setBriefing] = useState(room.mission.briefing);
  const [status, setStatus] = useState(room.status ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    setName(room.room_name);
    setGoal(room.mission.goal);
    setBriefing(room.mission.briefing);
    setStatus(room.status ?? '');
    setError(undefined);
  }, [open, room.mission.briefing, room.mission.goal, room.room_id, room.room_name, room.status]);
  if (!open) return null;

  const nameError = roomNameError(name);
  const goalError = exactMissionError('Goal', goal);
  const briefingError = exactMissionError('Briefing', briefing);
  const statusError = room.status && !status ? 'An existing status cannot be cleared.' : undefined;
  const changes: { name?: string; goal?: string; briefing?: string; status?: string } = {};
  const normalizedName = normalizeRoomName(name);
  if (normalizedName !== room.room_name) changes.name = normalizedName;
  if (goal !== room.mission.goal) changes.goal = goal;
  if (briefing !== room.mission.briefing) changes.briefing = briefing;
  if (status !== (room.status ?? '')) changes.status = status;
  const dirty = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!connected || !capable || !dirty || nameError || goalError || briefingError || statusError || submittingRef.current) return;
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
        <TextField label="Name" value={name} onChange={setName} error={nameError} autoFocus />
        <MissionField label="Goal" value={goal} onChange={setGoal} error={goalError} rows={3} />
        <MissionField label="Briefing" value={briefing} onChange={setBriefing} error={briefingError} rows={5} />
        <TextField label="Status (optional)" value={status} onChange={setStatus} error={statusError} />
        {(!connected || !capable) && <p className="form-error" role="status">Settings are unavailable because the connection or room lifecycle changed. Your fields are retained and no request was sent.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="primary-button" type="submit" disabled={!connected || !capable || submitting || !dirty || Boolean(nameError || goalError || briefingError || statusError)}>{submitting ? 'Saving…' : 'Save settings'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CloseRoomDialog({ room, open, connected, capable, restoreFocus, onClose, onConfirm }: {
  room: RoomDto;
  open: boolean;
  connected: boolean;
  capable: boolean;
  restoreFocus?: HTMLElement;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);
  if (!open) return null;
  const title = roomTitle(room);
  const confirmed = confirmation === title || confirmation === room.room_id;
  const canSubmit = confirmed && connected && capable;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try { await onConfirm(); }
    catch (failure) { setError(mutationError(failure, 'close', 'Your confirmation is retained.')); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  return (
    <Modal title="Close room" open={open} restoreFocus={restoreFocus} onClose={onClose} locked={submitting}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-intro">Closing is forward-only. Live packet state is removed, while the plaintext local archive remains readable on this host.</p>
        <p className="destructive-target">Type <strong>{title}</strong> or the exact room ID <code>{room.room_id}</code> to continue.</p>
        <TextField label="Type room title or ID to close" value={confirmation} onChange={setConfirmation} />
        {(!connected || !capable) && <p className="form-error" role="status">Close is unavailable because the connection or room lifecycle changed. No request was sent.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button><button className="danger-button" type="submit" disabled={!canSubmit || submitting}>{submitting ? 'Closing room…' : 'Close room permanently'}</button></div>
      </form>
    </Modal>
  );
}

export function DeleteRoomDialog({ room, open, connected, capable, restoreFocus, onClose, onConfirm }: {
  room: RoomDto;
  open: boolean;
  connected: boolean;
  capable: boolean;
  restoreFocus?: HTMLElement;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const submittingRef = useRef(false);
  if (!open) return null;
  const confirmed = confirmation === room.room_id;
  const canSubmit = confirmed && connected && capable;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    try { await onConfirm(); }
    catch (failure) { setError(mutationError(failure, 'delete', 'Your confirmation is retained.')); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  return (
    <Modal title="Delete room" open={open} restoreFocus={restoreFocus} onClose={onClose} locked={submitting}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-intro">This deletes the plaintext local archive and room metadata from this host. It does not purge remote copies or backups and does not securely erase storage or keys.</p>
        <p className="destructive-target">Type the exact room ID <code>{room.room_id}</code> to continue.</p>
        <TextField label="Type exact room ID to delete" value={confirmation} onChange={setConfirmation} />
        {(!connected || !capable) && <p className="form-error" role="status">Delete is unavailable because the connection or room lifecycle changed. No request was sent.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Cancel</button><button className="danger-button" type="submit" disabled={!canSubmit || submitting}>{submitting ? 'Deleting room…' : 'Delete local archive'}</button></div>
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

function TextField({ label, value, onChange, error, autoFocus = false }: { label: string; value: string; onChange(value: string): void; error?: string; autoFocus?: boolean }) {
  const id = useId();
  const errorId = `${id}-error`;
  return <div className="field"><label htmlFor={id}>{label}</label><input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoFocus={autoFocus} data-autofocus={autoFocus ? 'true' : undefined} />{error && <small id={errorId} className="field-error">{error}</small>}</div>;
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

function mutationError(failure: unknown, action: string, retained: string): string {
  if (failure instanceof RpcError && failure.outcomeUnknown) {
    return `The ${action} request did not receive a confirmation, so its outcome is unknown. ${retained} ${failure.message}`;
  }
  return failure instanceof Error ? failure.message : `Room ${action} failed.`;
}
