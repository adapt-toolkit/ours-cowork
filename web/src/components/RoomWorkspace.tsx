import { useState } from 'react';

import type { RoomDto } from '../api/types';
import { roomCapabilities } from '../state/roomModel';
import { roomTitle } from './RoomRail';

type WorkspaceTab = 'communication' | 'events' | 'archive';

export function RoomWorkspace({ room, connected, onOpenRooms, onOpenContext, onSettings }: {
  room?: RoomDto;
  connected: boolean;
  onOpenRooms(): void;
  onOpenContext(): void;
  onSettings(): void;
}) {
  const [tab, setTab] = useState<WorkspaceTab>('communication');

  if (!room) {
    return (
      <main className="workspace workspace--empty">
        <button className="icon-button mobile-rooms" type="button" onClick={onOpenRooms} aria-label="Open rooms">☰</button>
        <div className="empty-workspace">
          <span className="empty-workspace__glyph" aria-hidden="true">⌁</span>
          <p className="eyebrow">Mission control</p>
          <h1>Select a room</h1>
          <p>Choose a mission room to inspect its state and coordinate its work.</p>
        </div>
      </main>
    );
  }

  const capabilities = roomCapabilities(room.state, connected);
  return (
    <main className="workspace">
      <header className="workspace-header">
        <button className="icon-button mobile-rooms" type="button" onClick={onOpenRooms} aria-label="Open rooms">☰</button>
        <div className="workspace-identity">
          <p className="eyebrow">Mission room</p>
          <h1>{roomTitle(room)}</h1>
          <p className="mono identity-name">{room.identity_name}</p>
        </div>
        <span className={`lifecycle-badge lifecycle-badge--${room.state}`}>{lifecycleLabel(room.state)}</span>
        <button className="secondary-button context-toggle" type="button" onClick={onOpenContext}>Context</button>
      </header>

      <div className="mission-strip">
        <span>Goal</span><p>{room.mission.goal}</p>
        <button className="quiet-button" type="button" onClick={onSettings} disabled={!capabilities.canEditSettings}>Room settings</button>
      </div>

      <nav className="workspace-tabs" aria-label="Room workspace">
        {(['communication', 'events', 'archive'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      <section className="workspace-content" aria-label={`${tab} panel`}>
        {tab === 'communication' && <CommunicationShell room={room} />}
        {tab === 'events' && <Placeholder title="Operational events" copy="Relay, close, and recovery events will appear here as the room runs." />}
        {tab === 'archive' && <Placeholder title="Durable archive" copy="The complete ordered room record stream will appear here." />}
      </section>
    </main>
  );
}

function CommunicationShell({ room }: { room: RoomDto }) {
  const stateCopy = room.state === 'provisioning'
    ? { title: 'Room setup in progress', copy: 'Add invitation requirements and wait for the required participants to accept.' }
    : room.state === 'active'
      ? { title: 'Communication ready', copy: 'The group timeline and room composer are added in the communication stage.' }
      : room.state === 'closing'
        ? { title: 'Room closure in progress', copy: 'Mutations are disabled while durable close work completes.' }
        : { title: 'Read-only archive', copy: 'The closed room no longer accepts mutations; its local archive remains available.' };
  return (
    <div className="communication-shell">
      <article className="briefing-card">
        <p className="eyebrow">Mission briefing</p>
        <p>{room.mission.briefing}</p>
      </article>
      <Placeholder
        title={stateCopy.title}
        copy={stateCopy.copy}
      />
    </div>
  );
}

function Placeholder({ title, copy }: { title: string; copy: string }) {
  return <div className="panel-placeholder"><span aria-hidden="true">···</span><h2>{title}</h2><p>{copy}</p></div>;
}

function lifecycleLabel(state: RoomDto['state']): string {
  return state === 'provisioning' ? 'Provisioning' : state[0].toUpperCase() + state.slice(1);
}
