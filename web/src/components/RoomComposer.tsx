import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';

import type { RoomState } from '../api/types';

const MAX_MESSAGE_BYTES = 262_144;

/** The room's own voice. Reserved by the daemon, so it can never be a REST role. */
export const ROOM_VOICE = '';

export interface RoomComposerState {
  draft: string;
  pending: boolean;
  error?: string;
  /**
   * Registered REST role this room's composer authors under, or undefined for the
   * room's own voice. Kept in composer state, not component state, so switching
   * rooms cannot carry one room's selection into another.
   */
  sendAsRole?: string;
}

export function RoomComposer({ roomState, connected, state, restRoles = [], onDraftChange, onSendAsRoleChange, onSend }: {
  roomState: RoomState;
  connected: boolean;
  state: RoomComposerState;
  restRoles?: readonly string[];
  onDraftChange(value: string): void;
  onSendAsRoleChange?(role: string | undefined): void;
  onSend(text: string): Promise<void>;
}) {
  const { draft, pending, error, sendAsRole } = state;
  const enabled = roomState === 'active' && connected;
  const draftError = byteLength(draft) > MAX_MESSAGE_BYTES ? `Message must be at most ${MAX_MESSAGE_BYTES} UTF-8 bytes.` : undefined;
  // A role the daemon no longer lists was unregistered under us. Refuse the send
  // rather than silently falling back to the room's own voice, which would put the
  // message out under an author the operator did not pick.
  const staleRole = sendAsRole !== undefined && !restRoles.includes(sendAsRole) ? sendAsRole : undefined;
  const roleError = staleRole !== undefined
    ? `Role “${staleRole}” is no longer registered for REST authorship in this room. Pick another author.`
    : undefined;
  const canSend = enabled && !pending && draft.length > 0 && !draftError && !roleError;
  const showSendAs = restRoles.length > 0 || staleRole !== undefined;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    await onSend(draft);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  }

  function changeSendAs(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    onSendAsRoleChange?.(value === ROOM_VOICE ? undefined : value);
  }

  const disabledReason = !connected ? 'Disconnected. Drafts remain local until the daemon is available.'
    : roomState !== 'active' ? `Messaging is unavailable while the room is ${roomState}.`
      : undefined;
  return (
    <form className="room-composer" onSubmit={submit}>
      {showSendAs && (
        <div className={`composer-send-as${sendAsRole === undefined ? '' : ' composer-send-as--role'}`}>
          <label htmlFor="room-send-as">Send as</label>
          <select id="room-send-as" value={sendAsRole ?? ROOM_VOICE} disabled={!enabled || pending} onChange={changeSendAs} aria-describedby="send-as-help">
            <option value={ROOM_VOICE}>The room itself</option>
            {restRoles.map((role) => <option key={role} value={role}>{role}</option>)}
            {staleRole !== undefined && <option value={staleRole}>{staleRole} (no longer registered)</option>}
          </select>
          <small id="send-as-help">
            {sendAsRole === undefined
              ? 'Testing affordance. Messages go out in the room’s own voice.'
              : `Testing affordance. Messages go out signed by the room identity, labelled “${sendAsRole}”. Registered REST roles only; register or remove them with ours-cowork room rest-role.`}
          </small>
        </div>
      )}
      <label className="visually-hidden" htmlFor="room-message">Message the room</label>
      <textarea id="room-message" rows={3} value={draft} disabled={!enabled || pending} placeholder={sendAsRole === undefined ? 'Message as the room identity' : `Message as the room identity, labelled “${sendAsRole}”`} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={keyDown} aria-describedby="composer-help" aria-invalid={Boolean(draftError)} />
      <div className="composer-footer"><small id="composer-help">{draftError ?? roleError ?? disabledReason ?? 'Enter to send · Shift+Enter for a new line'}</small><button className="primary-button" type="submit" disabled={!canSend}>{pending ? 'Sending…' : sendAsRole === undefined ? 'Send message' : `Send as ${sendAsRole}`}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
