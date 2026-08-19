import { useRef, useState } from 'react';

import type { CommunicationRecordDto, RoomDto } from '../api/types';
import { roomCapabilities } from '../state/roomModel';
import { ArchiveView } from './ArchiveView';
import { ChatTimeline } from './ChatTimeline';
import { FilesView } from './FilesView';
import { RoomComposer, type RoomComposerState } from './RoomComposer';
import { roomTitle } from './RoomRail';

const WORKSPACE_TABS = ['communication', 'files', 'events', 'archive'] as const;
type WorkspaceTab = typeof WORKSPACE_TABS[number];

export function RoomWorkspace({ room, records = [], historyReady = false, connected, visible = true, composerState, onComposerDraft, onComposerSendAsRole, onOpenRooms, onOpenContext, onSettings, onSendMessage = unavailable }: {
  room?: RoomDto;
  records?: readonly CommunicationRecordDto[];
  historyReady?: boolean;
  connected: boolean;
  visible?: boolean;
  composerState?: RoomComposerState;
  onComposerDraft?(value: string): void;
  onComposerSendAsRole?(role: string | undefined): void;
  onOpenRooms(): void;
  onOpenContext(): void;
  onSettings(trigger: HTMLButtonElement): void;
  onSendMessage?(text: string): Promise<void>;
}) {
  const [tab, setTab] = useState<WorkspaceTab>('communication');
  const tabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement>>>({});

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
        </div>
        <span className={`lifecycle-badge lifecycle-badge--${room.state}`}>{lifecycleLabel(room.state)}</span>
        <button className="secondary-button context-toggle" type="button" onClick={onOpenContext} data-modal-fallback="true">Context</button>
      </header>

      <div className="mission-strip">
        <span>Goal</span><p>{room.mission.goal}</p>
        <button className="quiet-button" type="button" onClick={(event) => onSettings(event.currentTarget)} disabled={!capabilities.canEditSettings}>Room settings</button>
      </div>

      <nav className="workspace-tabs" aria-label="Room workspace" role="tablist">
        {WORKSPACE_TABS.map((value) => (
          <button
            key={value}
            ref={(node) => { tabRefs.current[value] = node ?? undefined; }}
            id={`workspace-tab-${value}`}
            type="button"
            role="tab"
            aria-controls={`workspace-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const current = WORKSPACE_TABS.indexOf(value);
              const next = event.key === 'ArrowRight' ? (current + 1) % WORKSPACE_TABS.length
                : event.key === 'ArrowLeft' ? (current - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
                : event.key === 'Home' ? 0
                : event.key === 'End' ? WORKSPACE_TABS.length - 1
                : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const nextTab = WORKSPACE_TABS[next]!;
              setTab(nextTab);
              tabRefs.current[nextTab]?.focus();
            }}
          >
            {value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>

      <section className="workspace-content" id={`workspace-panel-${tab}`} role="tabpanel" aria-labelledby={`workspace-tab-${tab}`} aria-label={`${tab} panel`} tabIndex={0}>
        {tab === 'communication' && <CommunicationShell room={room} records={records} historyReady={historyReady} connected={connected} visible={visible} composerState={composerState ?? EMPTY_COMPOSER} onComposerDraft={onComposerDraft ?? noopDraft} onComposerSendAsRole={onComposerSendAsRole} onSendMessage={onSendMessage} />}
        {tab === 'files' && <FilesView roomId={room.room_id} records={records} />}
        {tab === 'events' && <ArchiveView records={records} mode="events" />}
        {tab === 'archive' && <ArchiveView records={records} mode="archive" />}
      </section>
    </main>
  );
}

function CommunicationShell({ room, records, historyReady, connected, visible, composerState, onComposerDraft, onComposerSendAsRole, onSendMessage }: { room: RoomDto; records: readonly CommunicationRecordDto[]; historyReady: boolean; connected: boolean; visible: boolean; composerState: RoomComposerState; onComposerDraft(value: string): void; onComposerSendAsRole?(role: string | undefined): void; onSendMessage(text: string): Promise<void> }) {
  const archivedBriefing = records.some((record) => record.kind === 'message' && record.category === 'briefing');
  return (
    <div className="communication-shell">
      {!archivedBriefing && <article className="briefing-card">
        <p className="eyebrow">Mission briefing</p>
        <p>{room.mission.briefing}</p>
      </article>}
      {room.state !== 'active' && <p className={`lifecycle-separator lifecycle-separator--${room.state}`}>{room.state === 'provisioning' ? 'Room setup in progress · messaging begins after activation' : room.state === 'closing' ? 'Room closure in progress · mutations are disabled' : 'Room closed · read-only local archive'}</p>}
      <ChatTimeline roomId={room.room_id} records={records} historyReady={historyReady} visible={visible} />
      <RoomComposer roomState={room.state} connected={connected} state={composerState} restRoles={room.rest_roles ?? []} onDraftChange={onComposerDraft} onSendAsRoleChange={onComposerSendAsRole} onSend={onSendMessage} />
    </div>
  );
}

function Placeholder({ title, copy }: { title: string; copy: string }) {
  return <div className="panel-placeholder"><span aria-hidden="true">···</span><h2>{title}</h2><p>{copy}</p></div>;
}

function lifecycleLabel(state: RoomDto['state']): string {
  return state === 'provisioning' ? 'Provisioning' : state[0].toUpperCase() + state.slice(1);
}

async function unavailable(): Promise<never> { throw new Error('Room messaging is unavailable.'); }
const EMPTY_COMPOSER: RoomComposerState = { draft: '', pending: false };
function noopDraft(): void {}
