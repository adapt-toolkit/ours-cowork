import type { RoomDto, RoomState } from '../api/types';
import { unmetInviteCount } from '../state/roomModel';

export interface RoomRailProps {
  rooms: readonly RoomDto[];
  selectedRoomId?: string;
  connected: boolean | null;
  open: boolean;
  onClose(): void;
  onCreate(): void;
  onSelect(roomId: string): void;
}

const STATE_LABELS: Record<RoomState, string> = {
  provisioning: 'Provisioning',
  active: 'Active',
  closing: 'Closing',
  closed: 'Closed',
};

export function roomTitle(room: Pick<RoomDto, 'room_id' | 'mission'>): string {
  const goal = room.mission.goal.trim();
  if (goal) return goal;
  return room.room_id.length > 18 ? `${room.room_id.slice(0, 15)}…` : room.room_id;
}

export function RoomRail({
  rooms, selectedRoomId, connected, open, onClose, onCreate, onSelect,
}: RoomRailProps) {
  const openRooms = rooms.filter((room) => room.state !== 'closed');
  const closedRooms = rooms.filter((room) => room.state === 'closed');

  return (
    <aside className={`room-rail${open ? ' room-rail--open' : ''}`} aria-label="Mission rooms">
      <div className="rail-brand">
        <div className="brand-mark" aria-hidden="true">O</div>
        <div><strong>ours cowork</strong><span>operations console</span></div>
        <button className="icon-button rail-close" type="button" onClick={onClose} aria-label="Close rooms">×</button>
      </div>

      <button className="primary-button create-button" type="button" onClick={onCreate} disabled={connected !== true}>
        <span aria-hidden="true">＋</span> Create room
      </button>

      <div className={`connection-state connection-state--${connected === false ? 'offline' : connected ? 'online' : 'pending'}`}>
        <span className="state-dot" aria-hidden="true" />
        {connected === false ? 'Disconnected' : connected ? 'Connected' : 'Connecting'}
      </div>

      <RoomGroup label="Open rooms" rooms={openRooms} selectedRoomId={selectedRoomId} onSelect={onSelect} />
      <RoomGroup label="Closed rooms" rooms={closedRooms} selectedRoomId={selectedRoomId} onSelect={onSelect} />

      <p className="local-boundary">Local daemon · 127.0.0.1</p>
    </aside>
  );
}

function RoomGroup({ label, rooms, selectedRoomId, onSelect }: {
  label: string;
  rooms: readonly RoomDto[];
  selectedRoomId?: string;
  onSelect(roomId: string): void;
}) {
  return (
    <section className="room-group" aria-label={label}>
      <div className="room-group__heading"><h2>{label}</h2><span>{rooms.length}</span></div>
      {rooms.length === 0 ? <p className="empty-group">No {label.toLowerCase()}</p> : (
        <ul className="room-list">
          {rooms.map((room) => {
            const selected = room.room_id === selectedRoomId;
            return (
              <li key={room.room_id}>
                <button className="room-card" type="button" aria-current={selected ? 'page' : undefined} onClick={() => onSelect(room.room_id)}>
                  <span className="room-card__title">{roomTitle(room)}</span>
                  <span className="room-card__state"><span className={`lifecycle-dot lifecycle-dot--${room.state}`} aria-hidden="true" />{STATE_LABELS[room.state]}</span>
                  <span className="room-card__summary">{room.seats.length} accepted · {unmetInviteCount(room)} needed</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
