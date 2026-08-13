import type { Ref } from 'react';

import type { InviteMode, ParticipantDto, RoomDto } from '../api/types';
import { roomCapabilities, unmetInviteCount } from '../state/roomModel';
import { InviteManager } from './InviteManager';

export type ContextTab = 'state' | 'participants' | 'invite';

export function RoomContext({ room, participants = [], archiveCount = 0, connected = false, tab, open, drawer, panelRef, onTab, onClose, onCreateInvite = unavailable, onRevokeInvite = unavailable, onRecoverInvites = unavailable, onRequestClose = noop, onRequestDelete = noop }: {
  room?: RoomDto; participants?: ParticipantDto[]; connected?: boolean; tab: ContextTab; open: boolean; drawer: boolean; panelRef?: Ref<HTMLElement>;
  archiveCount?: number;
  onTab(tab: ContextTab): void; onClose(): void;
  onCreateInvite?(input: { mode: InviteMode; role: string; min_accepts: number }): Promise<void>;
  onRevokeInvite?(inviteId: string): Promise<unknown>;
  onRecoverInvites?(): Promise<void>;
  onRequestClose?(trigger: HTMLButtonElement): void;
  onRequestDelete?(trigger: HTMLButtonElement): void;
}) {
  const hidden = drawer && !open;
  return <aside ref={panelRef} className={`room-context${open ? ' room-context--open' : ''}`} aria-label="Room context" aria-hidden={hidden || undefined} hidden={hidden} tabIndex={-1}>
    <header className="context-header"><div><p className="eyebrow">Room context</p><h2>{room ? 'Mission details' : 'No room selected'}</h2></div><button className="icon-button context-close" type="button" onClick={onClose} aria-label="Close context">×</button></header>
    {room && <><div className="context-tabs" role="tablist" aria-label="Room context views"><button type="button" role="tab" aria-selected={tab === 'state'} onClick={() => onTab('state')}>State</button><button type="button" role="tab" aria-selected={tab === 'participants'} onClick={() => onTab('participants')}>Participants</button><button type="button" role="tab" aria-selected={tab === 'invite'} onClick={() => onTab('invite')}>Invite</button></div>
      {tab === 'state' ? <StatePanel room={room} archiveCount={archiveCount} connected={connected} onRequestClose={onRequestClose} onRequestDelete={onRequestDelete} /> : tab === 'participants' ? <ParticipantsPanel room={room} participants={participants} /> : <div className="context-body" role="tabpanel" aria-label="Invites"><div className="setup-callout"><span aria-hidden="true">↗</span><div><h3>Build the room roster</h3><p>Add invitation requirements one at a time. Each confirmed requirement is durable and can be retried independently.</p></div></div><dl className="state-grid state-grid--compact"><div><dt>Requirements</dt><dd>{room.invites.length}</dd></div><div><dt>Still needed</dt><dd>{unmetInviteCount(room)}</dd></div></dl><InviteManager key={room.room_id} room={room} connected={connected} onCreate={onCreateInvite} onRevoke={onRevokeInvite} onRecover={onRecoverInvites} /></div>}
    </>}
  </aside>;
}

function StatePanel({ room, archiveCount, connected, onRequestClose, onRequestDelete }: { room: RoomDto; archiveCount: number; connected: boolean; onRequestClose(trigger: HTMLButtonElement): void; onRequestDelete(trigger: HTMLButtonElement): void }) { const capabilities = roomCapabilities(room.state, connected); return <div className="context-body" role="tabpanel" aria-label="State"><dl className="state-grid"><div><dt>Lifecycle</dt><dd className={`state-text state-text--${room.state}`}>{title(room.state)}</dd></div><div><dt>Accepted seats</dt><dd>{room.seats.length}</dd></div><div><dt>Unmet requirements</dt><dd>{unmetInviteCount(room)}</dd></div><div><dt>Archive</dt><dd>{archiveCount} records</dd></div></dl><Detail label="Room name" value={room.room_name} />{room.status && <Detail label="Status" value={room.status} />}<Detail label="Room ID" value={room.room_id} mono /><Detail label="Identity CID" value={room.identity_cid || 'Pending'} mono /><Detail label="Created" value={formatDate(room.created_at)} />{room.closed_at && <Detail label="Closed" value={formatDate(room.closed_at)} />}<div className="management-actions">{capabilities.canClose && <button className="danger-button" type="button" onClick={(event) => onRequestClose(event.currentTarget)}>Close room</button>}{capabilities.canDelete && <button className="danger-button" type="button" onClick={(event) => onRequestDelete(event.currentTarget)}>Delete room</button>}</div></div>; }

function ParticipantsPanel({ room, participants }: { room: RoomDto; participants: ParticipantDto[] }) { return <div className="context-body" role="tabpanel" aria-label="Participants"><p className={`state-text state-text--${room.state}`}>{title(room.state)}</p><p>{participants.length} {participants.length === 1 ? 'seat' : 'seats'}</p>{room.invites.map((invite) => <p key={invite.invite_id}><strong>{invite.role}</strong>: {invite.accepted_cids.length} of {invite.min_accepts} accepted</p>)}<div className="participant-list">{participants.map((participant) => <article className="participant-card" key={participant.participant_id ?? participant.identity}><strong>{participant.display_name}</strong><span>{participant.role}{participant.state === 'pending' ? ' · pending' : ''}</span><code className="mono">{participant.identity}</code><small>via {participant.invite_id} · {formatDate(participant.accepted_at ?? participant.requested_at!)}</small></article>)}{participants.length === 0 && <p className="context-note">No participants admitted yet.</p>}</div></div>; }
function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="detail-row"><span>{label}</span><strong className={mono ? 'mono' : undefined}>{value}</strong></div>; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }
function title(value: string) { return `${value.charAt(0).toUpperCase()}${value.slice(1).replaceAll('_', ' ')}`; }
async function unavailable(): Promise<never> { throw new Error('Invite management is unavailable.'); }
function noop(): void {}
