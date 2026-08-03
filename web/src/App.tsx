import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { rpcCall } from './api/rpc';
import { isCommunicationRecordDto, isDeleteRoomReceiptDto, isHistoryDto, isParticipantListDto, isRoomDto, isRoomListDto, validateConfirmedRecoveryInvite, validateCreatedInviteReceipt, validateRecoveryInviteReceipts, type CommunicationRecordDto, type InviteMode, type InviteReceiptDto, type ParticipantDto, type RoomDto } from './api/types';
import { InviteReceiptDialog, type InviteReceiptVault } from './components/InviteManager';
import { CloseRoomDialog, CreateRoomDialog, DeleteRoomDialog, SettingsDialog } from './components/RoomDialogs';
import { RoomContext, type ContextTab } from './components/RoomContext';
import { RoomRail } from './components/RoomRail';
import { RoomWorkspace } from './components/RoomWorkspace';
import { createPoller, type PollClock, type Poller } from './state/poller';
import { mergeRecords } from './state/roomModel';

export interface RpcClient {
  call<T = unknown>(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<T>;
}

export type AppClock = PollClock;

const browserRpc: RpcClient = {
  call: <T,>(method: string, params: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
    rpcCall<T>(method, params, { signal: options?.signal }),
};

export function CoworkApp({ rpc = browserRpc, clock }: { rpc?: RpcClient; clock?: AppClock }) {
  const [rooms, setRooms] = useState<RoomDto[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | undefined>(() => roomIdFromHash(location.hash));
  const [selectedRoom, setSelectedRoom] = useState<RoomDto>();
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [historyByRoom, setHistoryByRoom] = useState<Record<string, CommunicationRecordDto[]>>({});
  const [historyReadyByRoom, setHistoryReadyByRoom] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string>();
  const [banner, setBanner] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inviteReceiptVaults, setInviteReceiptVaults] = useState<InviteReceiptVault[]>([]);
  const [contextTab, setContextTab] = useState<ContextTab>('state');
  const [railOpen, setRailOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const contextDrawer = useMediaQuery('(max-width: 999px)');
  const roomSheet = useMediaQuery('(max-width: 759px)');
  const listPoller = useRef<Poller>();
  const selectedPoller = useRef<Poller>();
  const selectionGeneration = useRef(0);
  const historyByRoomRef = useRef<Record<string, CommunicationRecordDto[]>>({});
  const connectedRef = useRef<boolean | null>(null);
  const selectedRoomRef = useRef<RoomDto>();
  const selectedRoomIdRef = useRef(selectedRoomId);
  const createTrigger = useRef<HTMLButtonElement>();
  const settingsTrigger = useRef<HTMLButtonElement>();
  const closeTrigger = useRef<HTMLButtonElement>();
  const deleteTrigger = useRef<HTMLButtonElement>();
  const contextPanel = useRef<HTMLElement>(null);

  const updateConnected = useCallback((value: boolean) => { connectedRef.current = value; setConnected(value); }, []);
  const updateSelectedRoom = useCallback((value: RoomDto | undefined) => { selectedRoomRef.current = value; setSelectedRoom(value); }, []);

  const visible = useCallback(() => !document.hidden, []);
  const focusContextPanel = useCallback(() => contextPanel.current ?? undefined, []);
  const reportFailure = useCallback((failure: unknown, action?: string) => {
    const message = failure instanceof Error ? failure.message : 'Unexpected daemon error.';
    setBanner(action ? `${action}: ${message}` : message);
  }, []);

  useEffect(() => {
    const poller = createPoller({
      intervalMs: 5_000,
      visible,
      clock,
      run: async (signal) => {
        const selectedAtStart = selectedRoomIdRef.current;
        try {
          const result = await rpc.call('room.list', {}, { signal });
          if (!isRoomListDto(result)) throw new Error('daemon returned an invalid room list');
          setRooms(result);
          updateConnected(true);
          setBanner((current) => current?.startsWith('Disconnected:') ? undefined : current);
          if (selectedAtStart
            && selectedRoomIdRef.current === selectedAtStart
            && !result.some((room) => room.room_id === selectedAtStart)) {
            selectedRoomIdRef.current = undefined;
            setSelectedRoomId(undefined);
            updateSelectedRoom(undefined);
            setParticipants([]);
            setNotice(`Room “${selectedAtStart}” is no longer available. No local data was changed.`);
            if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
          }
        } catch (failure) {
          if (signal.aborted) return;
          updateConnected(false);
          const message = failure instanceof Error ? failure.message : 'cowork daemon is unavailable';
          setBanner(`Disconnected: ${message}. Loaded room data is preserved.`);
        }
      },
    });
    listPoller.current = poller;
    poller.start();
    void poller.refresh();
    const visibility = () => { if (!document.hidden) void poller.refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      listPoller.current = undefined;
      poller.stop();
    };
  }, [clock, rpc, updateConnected, updateSelectedRoom, visible]);

  useEffect(() => {
    const routeChanged = () => {
      const roomId = roomIdFromHash(location.hash);
      selectedRoomIdRef.current = roomId;
      setSelectedRoomId(roomId);
      setParticipants([]);
    };
    window.addEventListener('hashchange', routeChanged);
    return () => window.removeEventListener('hashchange', routeChanged);
  }, []);

  useEffect(() => {
    const generation = ++selectionGeneration.current;
    if (!selectedRoomId) { updateSelectedRoom(undefined); setParticipants([]); return; }
    const cached = rooms.find((room) => room.room_id === selectedRoomId);
    if (cached) updateSelectedRoom(cached);

    const poller = createPoller({
      intervalMs: 2_000,
      visible,
      clock,
      run: async (signal) => {
        try {
          const [roomOutcome, participantOutcome, historyOutcome] = await Promise.allSettled([
            rpc.call('room.show', { room_id: selectedRoomId }, { signal }),
            rpc.call('room.participants', { room_id: selectedRoomId }, { signal }),
            loadHistoryPages(selectedRoomId, generation, signal),
          ]);
          if (roomOutcome.status === 'rejected') throw roomOutcome.reason;
          const result = roomOutcome.value;
          if (!isRoomDto(result)) throw new Error('daemon returned invalid room details');
          if (selectionGeneration.current !== generation || result.room_id !== selectedRoomId) return;
          updateSelectedRoom(result);
          if (participantOutcome.status === 'fulfilled' && isParticipantListDto(participantOutcome.value)) {
            const nextParticipants = participantOutcome.value;
            setParticipants((current) => sameParticipants(current, nextParticipants) ? current : nextParticipants);
          }
          if (participantOutcome.status === 'fulfilled' && !isParticipantListDto(participantOutcome.value)) {
            reportFailure(new Error('daemon returned invalid participant details'), 'Participant refresh failed');
          } else if (participantOutcome.status === 'rejected' && !signal.aborted) {
            reportFailure(participantOutcome.reason, 'Participant refresh failed');
          }
          if (historyOutcome.status === 'rejected' && !signal.aborted) reportFailure(historyOutcome.reason, 'History refresh failed');
          setRooms((current) => current.map((room) => room.room_id === result.room_id ? result : room));
          updateConnected(true);
        } catch (failure) {
          if (signal.aborted || selectionGeneration.current !== generation) return;
          updateConnected(false);
          reportFailure(failure, 'Disconnected');
        }
      },
    });
    selectedPoller.current = poller;
    poller.start();
    void poller.refresh();
    const visibility = () => { if (!document.hidden) void poller.refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { document.removeEventListener('visibilitychange', visibility); if (selectedPoller.current === poller) selectedPoller.current = undefined; poller.stop(); };

    async function loadHistoryPages(roomId: string, expectedGeneration: number, signal: AbortSignal): Promise<void> {
      let records = historyByRoomRef.current[roomId] ?? [];
      let after = records.at(-1)?.seq ?? 0;
      while (!signal.aborted && selectionGeneration.current === expectedGeneration) {
        const result = await rpc.call('room.history', { room_id: roomId, after, limit: 200 }, { signal });
        if (!isHistoryDto(result)
          || result.some((record, index) => record.room_id !== roomId || record.seq !== after + index + 1)) {
          throw new Error('daemon returned an invalid history page');
        }
        if (signal.aborted || selectionGeneration.current !== expectedGeneration) return;
        const merged = result.length > 0 ? mergeRecords(records, result) : records;
        if (result.length > 0) {
          records = merged;
          historyByRoomRef.current = { ...historyByRoomRef.current, [roomId]: merged };
          setHistoryByRoom(historyByRoomRef.current);
        }
        if (result.length < 200) {
          setHistoryReadyByRoom((current) => current[roomId] ? current : { ...current, [roomId]: true });
          return;
        }
        after += result.length;
      }
    }
  }, [clock, reportFailure, rpc, selectedRoomId, updateConnected, updateSelectedRoom, visible]);

  const selectRoom = useCallback((roomId: string) => {
    selectedRoomIdRef.current = roomId;
    setSelectedRoomId(roomId);
    setParticipants([]);
    setNotice(undefined);
    setCloseOpen(false);
    setDeleteOpen(false);
    setRailOpen(false);
    const nextHash = `#/rooms/${encodeURIComponent(roomId)}`;
    if (location.hash !== nextHash) location.hash = nextHash;
  }, []);

  const refreshAfterMutation = useCallback(() => {
    void listPoller.current?.refresh();
    void selectedPoller.current?.refresh();
  }, []);

  const createRoom = useCallback(async (goal: string, briefing: string) => {
    try {
      const result = await rpc.call('room.create', { goal: goal.trim(), briefing: briefing.trim() });
      if (!isRoomDto(result)) throw new Error('daemon returned invalid created room details');
      setCreateOpen(false);
      setContextTab('invite');
      setContextOpen(true);
      selectRoom(result.room_id);
      refreshAfterMutation();
    } catch (failure) {
      reportFailure(failure, 'Create room failed');
      throw failure;
    }
  }, [refreshAfterMutation, reportFailure, rpc, selectRoom]);

  const saveSettings = useCallback(async (changes: { goal?: string; briefing?: string; status?: string }) => {
    if (!selectedRoomId || Object.keys(changes).length === 0) return;
    try {
      const result = await rpc.call('room.settings', { room_id: selectedRoomId, ...changes });
      if (!isRoomDto(result)) throw new Error('daemon returned invalid updated room details');
      setSettingsOpen(false);
      refreshAfterMutation();
    } catch (failure) {
      reportFailure(failure, 'Settings update failed');
      throw failure;
    }
  }, [refreshAfterMutation, reportFailure, rpc, selectedRoomId]);

  const activeRoom = useMemo(() => selectedRoom?.room_id === selectedRoomId
    ? selectedRoom : rooms.find((room) => room.room_id === selectedRoomId), [rooms, selectedRoom, selectedRoomId]);

  const createInvite = useCallback(async (input: { mode: InviteMode; role: string; min_accepts: number }): Promise<void> => {
    const requestedRoomId = selectedRoomId;
    if (!requestedRoomId) throw new Error('No room selected.');
    try {
      const request = { room_id: requestedRoomId, ...input };
      const result = await rpc.call('room.invite', request);
      const receipt = validateCreatedInviteReceipt(result, request);
      setInviteReceiptVaults((current) => [...current, { room_id: requestedRoomId, receipts: [receipt] }]);
      refreshAfterMutation();
    } catch (failure) { reportFailure(failure, 'Create invite failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc, selectedRoomId]);

  const revokeInvite = useCallback(async (inviteId: string) => {
    if (!selectedRoomId) throw new Error('No room selected.');
    try { const result = await rpc.call('room.revoke', { room_id: selectedRoomId, invite_id: inviteId }); refreshAfterMutation(); return result; }
    catch (failure) { reportFailure(failure, 'Revoke invite failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc, selectedRoomId]);

  const recoverInvites = useCallback(async (): Promise<void> => {
    const requestedRoom = activeRoom;
    if (!requestedRoom) throw new Error('No room selected.');
    try {
      const result = await rpc.call('room.recover', { room_id: requestedRoom.room_id });
      const receipts = validateRecoveryInviteReceipts(result, requestedRoom);
      if (receipts.length > 0) setInviteReceiptVaults((current) => [...current, { room_id: requestedRoom.room_id, receipts }]);
      refreshAfterMutation();
    }
    catch (failure) { reportFailure(failure, 'Recover invites failed'); throw failure; }
  }, [activeRoom, refreshAfterMutation, reportFailure, rpc]);

  const confirmRecovery = useCallback(async (receipt: InviteReceiptDto): Promise<void> => {
    if (!receipt.recovery_of) throw new Error('Recovery receipt has no old invite pointer.');
    try {
      const result = await rpc.call('room.recover.confirm', { room_id: receipt.room_id, recovery_of: receipt.recovery_of, invite_id: receipt.invite.invite_id });
      validateConfirmedRecoveryInvite(result, receipt);
      refreshAfterMutation();
    }
    catch (failure) { reportFailure(failure, 'Confirm recovery failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const sendMessage = useCallback(async (text: string): Promise<void> => {
    const requestedRoom = selectedRoomRef.current?.room_id === selectedRoomIdRef.current ? selectedRoomRef.current : activeRoom;
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. Your draft is retained.');
    if (!requestedRoom || requestedRoom.state !== 'active' || selectedRoomIdRef.current !== requestedRoom.room_id) throw new Error('The selected room is not active.');
    try {
      const result = await rpc.call('room.message', { room_id: requestedRoom.room_id, text });
      if (!isCommunicationRecordDto(result)
        || result.kind !== 'message'
        || result.room_id !== requestedRoom.room_id
        || result.category !== 'chat'
        || result.text !== text
        || result.author.identity !== requestedRoom.identity_cid
        || result.author.display_name !== requestedRoom.identity_name
        || result.author.role !== 'room') throw new Error('daemon returned invalid message confirmation');
      void selectedPoller.current?.refresh();
    } catch (failure) { reportFailure(failure, 'Send message failed'); throw failure; }
  }, [activeRoom, reportFailure, rpc]);

  const closeRoom = useCallback(async (): Promise<void> => {
    const requestedRoom = selectedRoomRef.current?.room_id === selectedRoomIdRef.current ? selectedRoomRef.current : activeRoom;
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The room was not closed.');
    if (!requestedRoom || selectedRoomIdRef.current !== requestedRoom.room_id || (requestedRoom.state !== 'active' && requestedRoom.state !== 'provisioning')) throw new Error('This room cannot be closed from its current state.');
    try {
      const result = await rpc.call('room.close', { room_id: requestedRoom.room_id });
      if (!isRoomDto(result) || result.room_id !== requestedRoom.room_id || result.state !== 'closed') {
        throw new Error('daemon returned invalid closed room details');
      }
      updateSelectedRoom(result);
      setRooms((current) => current.map((room) => room.room_id === result.room_id ? result : room));
      setCloseOpen(false);
      refreshAfterMutation();
    } catch (failure) { reportFailure(failure, 'Close room failed'); throw failure; }
  }, [activeRoom, refreshAfterMutation, reportFailure, rpc, updateSelectedRoom]);

  const deleteRoom = useCallback(async (): Promise<void> => {
    const requestedRoom = selectedRoomRef.current?.room_id === selectedRoomIdRef.current ? selectedRoomRef.current : activeRoom;
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The room was not deleted.');
    if (!requestedRoom || selectedRoomIdRef.current !== requestedRoom.room_id || requestedRoom.state !== 'closed') throw new Error('Only a closed room can be deleted.');
    try {
      const result = await rpc.call('room.delete', { room_id: requestedRoom.room_id, confirm: true });
      if (!isDeleteRoomReceiptDto(result) || result.room_id !== requestedRoom.room_id) throw new Error('daemon returned invalid deletion confirmation');
      const roomId = requestedRoom.room_id;
      setRooms((current) => current.filter((room) => room.room_id !== roomId));
      updateSelectedRoom(undefined);
      setSelectedRoomId(undefined);
      selectedRoomIdRef.current = undefined;
      setParticipants([]);
      historyByRoomRef.current = Object.fromEntries(Object.entries(historyByRoomRef.current).filter(([key]) => key !== roomId));
      setHistoryByRoom(historyByRoomRef.current);
      setHistoryReadyByRoom((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== roomId)));
      setDeleteOpen(false);
      setContextOpen(false);
      setNotice(`Room “${roomId}” was deleted from this host. Remote copies and backups were not purged.`);
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      void listPoller.current?.refresh();
    } catch (failure) { reportFailure(failure, 'Delete room failed'); throw failure; }
  }, [activeRoom, reportFailure, rpc, updateSelectedRoom]);

  return (
    <div className="cowork-app">
      <RoomRail rooms={rooms} selectedRoomId={selectedRoomId} connected={connected} open={railOpen} sheet={roomSheet} onClose={() => setRailOpen(false)} onCreate={(trigger) => { createTrigger.current = trigger; setCreateOpen(true); }} onSelect={selectRoom} />
      <RoomWorkspace room={activeRoom} records={activeRoom ? historyByRoom[activeRoom.room_id] ?? [] : []} historyReady={Boolean(activeRoom && historyReadyByRoom[activeRoom.room_id])} connected={connected === true} visible={!document.hidden} onOpenRooms={() => setRailOpen(true)} onOpenContext={() => setContextOpen(true)} onSettings={(trigger) => { settingsTrigger.current = trigger; setSettingsOpen(true); }} onSendMessage={sendMessage} />
      <RoomContext room={activeRoom} participants={participants} archiveCount={activeRoom ? historyByRoom[activeRoom.room_id]?.length ?? 0 : 0} connected={connected === true} tab={contextTab} open={contextOpen} drawer={contextDrawer} panelRef={contextPanel} onTab={setContextTab} onClose={() => setContextOpen(false)} onCreateInvite={createInvite} onRevokeInvite={revokeInvite} onRecoverInvites={recoverInvites} onRequestClose={(trigger) => { closeTrigger.current = trigger; setCloseOpen(true); }} onRequestDelete={(trigger) => { deleteTrigger.current = trigger; setDeleteOpen(true); }} />
      {((roomSheet && railOpen) || (contextDrawer && contextOpen)) && <button className="responsive-scrim" type="button" aria-label="Close open panel" onClick={() => { setRailOpen(false); setContextOpen(false); }} />}

      {connected === false && <div className="disconnect-banner" role="status"><strong>Disconnected</strong><span>Loaded data remains visible. Mutations are disabled until the daemon answers.</span></div>}
      {banner && <div className="error-banner" role="alert"><span>{banner}</span><button type="button" onClick={() => setBanner(undefined)} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="notice-banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(undefined)} aria-label="Dismiss notice">×</button></div>}

      <CreateRoomDialog open={createOpen} restoreFocus={createTrigger.current} fallbackFocus={focusContextPanel} onClose={() => setCreateOpen(false)} onCreate={createRoom} />
      {activeRoom && settingsOpen && <SettingsDialog key={activeRoom.room_id} room={activeRoom} open restoreFocus={settingsTrigger.current} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
      {activeRoom && closeOpen && <CloseRoomDialog key={`close:${activeRoom.room_id}`} room={activeRoom} open connected={connected === true} capable={activeRoom.state === 'provisioning' || activeRoom.state === 'active'} restoreFocus={closeTrigger.current} onClose={() => setCloseOpen(false)} onConfirm={closeRoom} />}
      {activeRoom && deleteOpen && <DeleteRoomDialog key={`delete:${activeRoom.room_id}`} room={activeRoom} open connected={connected === true} capable={activeRoom.state === 'closed'} restoreFocus={deleteTrigger.current} onClose={() => setDeleteOpen(false)} onConfirm={deleteRoom} />}
      {inviteReceiptVaults[0] && <InviteReceiptDialog vault={inviteReceiptVaults[0]} onClose={() => setInviteReceiptVaults((current) => current.slice(1))} onConfirm={confirmRecovery} />}
    </div>
  );
}

function roomIdFromHash(hash: string): string | undefined {
  const match = /^#\/rooms\/([^/?#]+)$/.exec(hash);
  if (!match?.[1]) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

function sameParticipants(left: ParticipantDto[], right: ParticipantDto[]): boolean {
  return left.length === right.length && left.every((participant, index) => JSON.stringify(participant) === JSON.stringify(right[index]));
}

function useMediaQuery(query: string): boolean {
  const media = useMemo(() => typeof window.matchMedia === 'function' ? window.matchMedia(query) : undefined, [query]);
  const [matches, setMatches] = useState(() => media?.matches ?? false);
  useEffect(() => {
    if (!media) return;
    const update = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [media]);
  return matches;
}
