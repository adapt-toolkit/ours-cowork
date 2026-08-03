import type { Ref } from 'react';

import type { RoomDto } from '../api/types';
import { unmetInviteCount } from '../state/roomModel';

export type ContextTab = 'state' | 'invite';

export function RoomContext({ room, tab, open, drawer, panelRef, onTab, onClose }: {
  room?: RoomDto;
  tab: ContextTab;
  open: boolean;
  drawer: boolean;
  panelRef?: Ref<HTMLElement>;
  onTab(tab: ContextTab): void;
  onClose(): void;
}) {
  const hidden = drawer && !open;
  return (
    <aside ref={panelRef} className={`room-context${open ? ' room-context--open' : ''}`} aria-label="Room context" aria-hidden={hidden || undefined} hidden={hidden} tabIndex={-1}>
      <header className="context-header">
        <div><p className="eyebrow">Room context</p><h2>{room ? 'Mission details' : 'No room selected'}</h2></div>
        <button className="icon-button context-close" type="button" onClick={onClose} aria-label="Close context">×</button>
      </header>
      {room && <>
        <div className="context-tabs" role="tablist" aria-label="Room context views">
          <button type="button" role="tab" aria-selected={tab === 'state'} onClick={() => onTab('state')}>State</button>
          <button type="button" role="tab" aria-selected={tab === 'invite'} onClick={() => onTab('invite')}>Invite</button>
        </div>
        {tab === 'state' ? <StatePanel room={room} /> : <InvitePanel room={room} />}
      </>}
    </aside>
  );
}

function StatePanel({ room }: { room: RoomDto }) {
  return (
    <div className="context-body" role="tabpanel" aria-label="State">
      <dl className="state-grid">
        <div><dt>Lifecycle</dt><dd className={`state-text state-text--${room.state}`}>{room.state}</dd></div>
        <div><dt>Accepted seats</dt><dd>{room.seats.length}</dd></div>
        <div><dt>Unmet requirements</dt><dd>{unmetInviteCount(room)}</dd></div>
        <div><dt>Archive</dt><dd>Not loaded</dd></div>
      </dl>
      {room.status && <Detail label="Status" value={room.status} />}
      <Detail label="Room ID" value={room.room_id} mono />
      <Detail label="Identity CID" value={room.identity_cid || 'Pending'} mono />
      <Detail label="Created" value={formatDate(room.created_at)} />
      {room.closed_at && <Detail label="Closed" value={formatDate(room.closed_at)} />}
    </div>
  );
}

function InvitePanel({ room }: { room: RoomDto }) {
  return (
    <div className="context-body" role="tabpanel" aria-label="Invite">
      <div className="setup-callout"><span aria-hidden="true">↗</span><div><h3>Build the room roster</h3><p>Add invitation requirements one at a time. Each confirmed requirement is durable and can be retried independently.</p></div></div>
      <dl className="state-grid state-grid--compact">
        <div><dt>Requirements</dt><dd>{room.invites.length}</dd></div>
        <div><dt>Still needed</dt><dd>{unmetInviteCount(room)}</dd></div>
      </dl>
      <p className="context-note">Invitation creation, receipt handling, revocation, and recovery arrive in the next management stage.</p>
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? 'mono' : undefined}>{value}</strong></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
