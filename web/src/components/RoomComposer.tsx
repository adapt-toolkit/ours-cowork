import { type FormEvent, type KeyboardEvent, useRef } from 'react';

import type { RoomState } from '../api/types';

const MAX_MESSAGE_BYTES = 262_144;

export interface RoomComposerState {
  draft: string;
  pending: boolean;
  error?: string;
}

export function RoomComposer({ roomState, connected, state, onDraftChange, onSend }: {
  roomState: RoomState;
  connected: boolean;
  state: RoomComposerState;
  onDraftChange(value: string): void;
  onSend(text: string): Promise<void>;
}) {
  const pendingRef = useRef(false);
  const { draft, pending, error } = state;
  const enabled = roomState === 'active' && connected;
  const draftError = byteLength(draft) > MAX_MESSAGE_BYTES ? `Message must be at most ${MAX_MESSAGE_BYTES} UTF-8 bytes.` : undefined;
  const canSend = enabled && !pending && draft.length > 0 && !draftError;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend || pendingRef.current) return;
    const submitted = draft;
    pendingRef.current = true;
    try { await onSend(submitted); }
    finally { pendingRef.current = false; }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  const disabledReason = !connected ? 'Disconnected. Drafts remain local until the daemon is available.'
    : roomState !== 'active' ? `Messaging is unavailable while the room is ${roomState}.`
      : undefined;
  return (
    <form className="room-composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor="room-message">Message the room</label>
      <textarea id="room-message" rows={3} value={draft} disabled={!enabled || pending} placeholder="Message as the room identity" onChange={(event) => onDraftChange(event.target.value)} onKeyDown={keyDown} aria-describedby="composer-help" aria-invalid={Boolean(draftError)} />
      <div className="composer-footer"><small id="composer-help">{draftError ?? disabledReason ?? 'Enter to send · Shift+Enter for a new line'}</small><button className="primary-button" type="submit" disabled={!canSend}>{pending ? 'Sending…' : 'Send message'}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
