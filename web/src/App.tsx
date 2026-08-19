import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RpcError, rpcCall } from './api/rpc';
import { isCommunicationRecordDto, isDeleteRoomReceiptDto, isHistoryDto, isParticipantListDto, isRoomDto, isRoomListDto, validateConfirmedRecoveryInvite, validateCreatedInviteReceipt, validateRecoveryInviteReceipts, type CommunicationRecordDto, type InviteMode, type InviteReceiptDto, type ParticipantDto, type RoomDto } from './api/types';
import { InviteReceiptDialog, type InviteReceiptVault } from './components/InviteManager';
import { CloseRoomDialog, CreateRoomDialog, DeleteRoomDialog, SettingsDialog } from './components/RoomDialogs';
import { RoomContext, type ContextTab } from './components/RoomContext';
import type { RoomComposerState } from './components/RoomComposer';
import { RoomRail } from './components/RoomRail';
import { RoomWorkspace } from './components/RoomWorkspace';
import { createPoller, type PollClock, type Poller } from './state/poller';
import { mergeRecords, roomCapabilities } from './state/roomModel';

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
  const [composerByRoom, setComposerByRoom] = useState<Record<string, RoomComposerState>>({});
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
  const composerByRoomRef = useRef<Record<string, RoomComposerState>>({});
  const roomsRef = useRef<RoomDto[]>([]);
  const deletedRoomIdsRef = useRef(new Set<string>());
  const connectedRef = useRef<boolean | null>(null);
  const selectedRoomRef = useRef<RoomDto>();
  const selectedRoomIdRef = useRef(selectedRoomId);
  const createTrigger = useRef<HTMLButtonElement>();
  const settingsTrigger = useRef<HTMLButtonElement>();
  const closeTrigger = useRef<HTMLButtonElement>();
  const deleteTrigger = useRef<HTMLButtonElement>();
  const contextPanel = useRef<HTMLElement>(null);

  const updateConnected = useCallback((value: boolean) => { connectedRef.current = value; setConnected(value); }, []);
  const updateSelectedRoom = useCallback((value: RoomDto | undefined) => {
    if (value && deletedRoomIdsRef.current.has(value.room_id)) return;
    selectedRoomRef.current = value;
    setSelectedRoom(value);
  }, []);
  const replaceRooms = useCallback((value: RoomDto[]) => {
    const next = value.filter((room) => !deletedRoomIdsRef.current.has(room.room_id));
    roomsRef.current = next;
    setRooms(next);
  }, []);
  const replaceRoom = useCallback((value: RoomDto) => {
    if (deletedRoomIdsRef.current.has(value.room_id)) return;
    const next = roomsRef.current.some((room) => room.room_id === value.room_id)
      ? roomsRef.current.map((room) => room.room_id === value.room_id ? value : room)
      : [...roomsRef.current, value];
    roomsRef.current = next;
    setRooms(next);
  }, []);
  const updateComposer = useCallback((roomId: string, update: (current: RoomComposerState) => RoomComposerState) => {
    if (deletedRoomIdsRef.current.has(roomId)) return;
    const next = update(composerByRoomRef.current[roomId] ?? EMPTY_COMPOSER);
    composerByRoomRef.current = { ...composerByRoomRef.current, [roomId]: next };
    setComposerByRoom(composerByRoomRef.current);
  }, []);

  const visible = useCallback(() => !document.hidden, []);
  const focusContextPanel = useCallback(() => contextPanel.current ?? undefined, []);
  const reportFailure = useCallback((failure: unknown, action?: string) => {
    const message = failure instanceof Error ? failure.message : 'Unexpected daemon error.';
    setBanner(action ? `${action}: ${message}` : message);
  }, []);

  const loadHistoryPages = useCallback(async (roomId: string, options: { signal?: AbortSignal; generation?: number } = {}): Promise<void> => {
    if (deletedRoomIdsRef.current.has(roomId)) return;
    let records = historyByRoomRef.current[roomId] ?? [];
    let after = records.at(-1)?.seq ?? 0;
    const current = () => !options.signal?.aborted
      && !deletedRoomIdsRef.current.has(roomId)
      && (options.generation === undefined || selectionGeneration.current === options.generation);
    while (current()) {
      const result = await rpc.call('room.history', { room_id: roomId, after, limit: 200 }, options.signal ? { signal: options.signal } : undefined);
      if (!current()) return;
      if (!isHistoryDto(result)
        || result.some((record, index) => record.room_id !== roomId || record.seq !== after + index + 1)) {
        throw new Error('daemon returned an invalid history page');
      }
      if (result.length > 0) {
        if (!current()) return;
        records = mergeRecords(historyByRoomRef.current[roomId] ?? records, result);
        historyByRoomRef.current = { ...historyByRoomRef.current, [roomId]: records };
        setHistoryByRoom(historyByRoomRef.current);
      }
      // Byte-bounded daemon pages can be shorter than the record limit even
      // when more history exists. Only an empty page is the EOF marker.
      if (result.length === 0) {
        if (!current()) return;
        setHistoryReadyByRoom((ready) => deletedRoomIdsRef.current.has(roomId) || ready[roomId]
          ? ready
          : { ...ready, [roomId]: true });
        return;
      }
      after += result.length;
    }
  }, [rpc]);

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
          const availableRooms = result.filter((room) => !deletedRoomIdsRef.current.has(room.room_id));
          replaceRooms(availableRooms);
          updateConnected(true);
          setBanner((current) => current?.startsWith('Disconnected:') ? undefined : current);
          if (selectedAtStart
            && selectedRoomIdRef.current === selectedAtStart
            && !availableRooms.some((room) => room.room_id === selectedAtStart)) {
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
  }, [clock, replaceRooms, rpc, updateConnected, updateSelectedRoom, visible]);

  useEffect(() => {
    const routeChanged = () => {
      const requestedRoomId = roomIdFromHash(location.hash);
      const roomId = requestedRoomId && !deletedRoomIdsRef.current.has(requestedRoomId) ? requestedRoomId : undefined;
      selectedRoomIdRef.current = roomId;
      setSelectedRoomId(roomId);
      setParticipants([]);
      if (requestedRoomId && !roomId) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
    };
    window.addEventListener('hashchange', routeChanged);
    return () => window.removeEventListener('hashchange', routeChanged);
  }, []);

  useEffect(() => {
    const generation = ++selectionGeneration.current;
    if (!selectedRoomId) { updateSelectedRoom(undefined); setParticipants([]); return; }
    if (deletedRoomIdsRef.current.has(selectedRoomId)) {
      selectedRoomIdRef.current = undefined;
      setSelectedRoomId(undefined);
      updateSelectedRoom(undefined);
      setParticipants([]);
      if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      return;
    }
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
            loadHistoryPages(selectedRoomId, { generation, signal }),
          ]);
          if (signal.aborted || selectionGeneration.current !== generation || deletedRoomIdsRef.current.has(selectedRoomId)) return;
          if (roomOutcome.status === 'rejected') throw roomOutcome.reason;
          const result = roomOutcome.value;
          if (!isRoomDto(result)) throw new Error('daemon returned invalid room details');
          if (selectionGeneration.current !== generation || deletedRoomIdsRef.current.has(selectedRoomId) || result.room_id !== selectedRoomId) return;
          updateSelectedRoom(result);
          if (participantOutcome.status === 'fulfilled' && isParticipantListDto(participantOutcome.value)) {
            const nextParticipants = participantOutcome.value;
            setParticipants((current) => deletedRoomIdsRef.current.has(selectedRoomId)
              || selectionGeneration.current !== generation
              || sameParticipants(current, nextParticipants)
              ? current
              : nextParticipants);
          }
          if (participantOutcome.status === 'fulfilled' && !isParticipantListDto(participantOutcome.value)) {
            reportFailure(new Error('daemon returned invalid participant details'), 'Participant refresh failed');
          } else if (participantOutcome.status === 'rejected' && !signal.aborted) {
            reportFailure(participantOutcome.reason, 'Participant refresh failed');
          }
          if (historyOutcome.status === 'rejected' && !signal.aborted) reportFailure(historyOutcome.reason, 'History refresh failed');
          replaceRoom(result);
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

  }, [clock, loadHistoryPages, replaceRoom, reportFailure, rpc, selectedRoomId, updateConnected, updateSelectedRoom, visible]);

  const selectRoom = useCallback((roomId: string) => {
    if (deletedRoomIdsRef.current.has(roomId)) {
      selectedRoomIdRef.current = undefined;
      setSelectedRoomId(undefined);
      updateSelectedRoom(undefined);
      setParticipants([]);
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      return;
    }
    selectedRoomIdRef.current = roomId;
    setSelectedRoomId(roomId);
    setParticipants([]);
    setNotice(undefined);
    setCloseOpen(false);
    setDeleteOpen(false);
    setRailOpen(false);
    const nextHash = `#/rooms/${encodeURIComponent(roomId)}`;
    if (location.hash !== nextHash) location.hash = nextHash;
  }, [updateSelectedRoom]);

  const refreshAfterMutation = useCallback(() => {
    void listPoller.current?.refresh();
    void selectedPoller.current?.refresh();
  }, []);

  const createRoom = useCallback(async (name: string, goal: string, briefing: string) => {
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. Your fields are retained.');
    try {
      const result = await rpc.call('room.create', { name, goal: goal.trim(), briefing: briefing.trim() });
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

  const saveSettings = useCallback(async (roomId: string, changes: { name?: string; goal?: string; briefing?: string; status?: string }) => {
    if (Object.keys(changes).length === 0) return;
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. Your fields are retained.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canEditSettings) throw new Error('Room settings are unavailable in the current lifecycle. Your fields are retained.');
    try {
      const result = await rpc.call('room.settings', { room_id: roomId, ...changes });
      if (!isRoomDto(result) || result.room_id !== roomId) throw new Error('daemon returned invalid updated room details');
      setSettingsOpen(false);
      refreshAfterMutation();
    } catch (failure) {
      reportFailure(failure, 'Settings update failed');
      throw failure;
    }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const activeRoom = useMemo(() => selectedRoom?.room_id === selectedRoomId
    ? selectedRoom : rooms.find((room) => room.room_id === selectedRoomId), [rooms, selectedRoom, selectedRoomId]);

  const createInvite = useCallback(async (requestedRoomId: string, input: { mode: InviteMode; role: string; min_accepts: number }): Promise<void> => {
    const requestedRoom = roomsRef.current.find((room) => room.room_id === requestedRoomId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The invite form is retained.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canCreateInvite) throw new Error('Invites are unavailable in the current room lifecycle. The form is retained.');
    try {
      const request = { room_id: requestedRoomId, ...input };
      const result = await rpc.call('room.invite', request);
      const receipt = validateCreatedInviteReceipt(result, request);
      setInviteReceiptVaults((current) => [...current, { room_id: requestedRoomId, receipts: [receipt] }]);
      refreshAfterMutation();
    } catch (failure) { reportFailure(failure, 'Create invite failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const revokeInvite = useCallback(async (roomId: string, inviteId: string) => {
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    const invite = requestedRoom?.invites.find((candidate) => candidate.invite_id === inviteId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The revoke confirmation is retained.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canRevokeInvite || !invite || !canRevokeInvite(invite.state)) {
      throw new Error('This invite can no longer be revoked. The confirmation is retained.');
    }
    try { const result = await rpc.call('room.revoke', { room_id: roomId, invite_id: inviteId }); refreshAfterMutation(); return result; }
    catch (failure) { reportFailure(failure, 'Revoke invite failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const recoverInvites = useCallback(async (roomId: string): Promise<void> => {
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. Recovery was not started.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canRecoverInvite
      || !requestedRoom.invites.some((invite) => invite.state === 'replacement_required')) {
      throw new Error('Invite recovery is unavailable in the current room state.');
    }
    try {
      const result = await rpc.call('room.recover', { room_id: requestedRoom.room_id });
      const receipts = validateRecoveryInviteReceipts(result, requestedRoom);
      if (receipts.length > 0) setInviteReceiptVaults((current) => [...current, { room_id: requestedRoom.room_id, receipts }]);
      refreshAfterMutation();
    }
    catch (failure) { reportFailure(failure, 'Recover invites failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const confirmRecovery = useCallback(async (receipt: InviteReceiptDto): Promise<void> => {
    if (!receipt.recovery_of) throw new Error('Recovery receipt has no old invite pointer.');
    const requestedRoom = roomsRef.current.find((room) => room.room_id === receipt.room_id);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The recovery receipt is retained.');
    if (!requestedRoom || !canConfirmRecovery(requestedRoom, receipt)) {
      throw new Error('The exact recovery lineage is no longer confirmable. The receipt is retained.');
    }
    try {
      const result = await rpc.call('room.recover.confirm', { room_id: receipt.room_id, recovery_of: receipt.recovery_of, invite_id: receipt.invite.invite_id });
      validateConfirmedRecoveryInvite(result, receipt);
      refreshAfterMutation();
    }
    catch (failure) { reportFailure(failure, 'Confirm recovery failed'); throw failure; }
  }, [refreshAfterMutation, reportFailure, rpc]);

  const sendMessage = useCallback(async (roomId: string, text: string): Promise<void> => {
    const currentComposer = composerByRoomRef.current[roomId] ?? EMPTY_COMPOSER;
    if (currentComposer.pending || currentComposer.draft !== text) return;
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    if (connectedRef.current !== true || !requestedRoom || !roomCapabilities(requestedRoom.state, true).canMessage) {
      updateComposer(roomId, (current) => ({ ...current, error: 'Messaging is unavailable because the connection or room lifecycle changed. Your draft is retained.' }));
      return;
    }
    // Re-check the role against the room the poller last returned, not against the
    // list the picker was rendered from: a role unregistered over the CLI meanwhile
    // must fail here rather than reach the daemon or fall back to the room's voice.
    const sendAsRole = currentComposer.sendAsRole;
    if (sendAsRole !== undefined && !(requestedRoom.rest_roles ?? []).includes(sendAsRole)) {
      updateComposer(roomId, (current) => ({ ...current, error: `Role “${sendAsRole}” is no longer registered for REST authorship in this room. Your draft is retained.` }));
      return;
    }
    updateComposer(roomId, (current) => ({ ...current, pending: true, error: undefined }));
    try {
      // Role authorship reuses the existing authenticated route; the daemon still
      // signs as the room, so the expected author is the room identity carrying the
      // role as both its label and display name (src/service.ts postAsRole).
      const result = sendAsRole === undefined
        ? await rpc.call('room.message', { room_id: roomId, text })
        : await rpc.call('room.say', { room_id: roomId, role: sendAsRole, text });
      const expectedDisplayName = sendAsRole ?? requestedRoom.identity_name;
      const expectedRole = sendAsRole ?? 'room';
      if (!isCommunicationRecordDto(result)
        || result.kind !== 'message'
        || result.room_id !== roomId
        || result.category !== 'chat'
        || result.text !== text
        || result.author.identity !== requestedRoom.identity_cid
        || result.author.display_name !== expectedDisplayName
        || result.author.role !== expectedRole) throw new Error('daemon returned invalid message confirmation');
      if (deletedRoomIdsRef.current.has(roomId)) return;
      updateComposer(roomId, (current) => ({
        draft: current.draft === text ? '' : current.draft,
        pending: false,
        sendAsRole: current.sendAsRole,
      }));
      void loadHistoryPages(roomId).catch((failure) => reportFailure(failure, 'History refresh failed'));
    } catch (failure) {
      updateComposer(roomId, (current) => ({ ...current, pending: false, error: messageFailure(failure) }));
    }
  }, [loadHistoryPages, reportFailure, rpc, updateComposer]);

  const closeRoom = useCallback(async (roomId: string): Promise<void> => {
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The room was not closed.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canClose) throw new Error('This room cannot be closed from its current state.');
    try {
      const result = await rpc.call('room.close', { room_id: roomId });
      if (!isRoomDto(result) || result.room_id !== roomId || result.state !== 'closed') {
        throw new Error('daemon returned invalid closed room details');
      }
      if (selectedRoomIdRef.current === roomId) updateSelectedRoom(result);
      replaceRoom(result);
      setCloseOpen(false);
      refreshAfterMutation();
    } catch (failure) { reportFailure(failure, 'Close room failed'); throw failure; }
  }, [refreshAfterMutation, replaceRoom, reportFailure, rpc, updateSelectedRoom]);

  const deleteRoom = useCallback(async (roomId: string): Promise<void> => {
    const requestedRoom = roomsRef.current.find((room) => room.room_id === roomId);
    if (connectedRef.current !== true) throw new Error('The daemon is disconnected. The room was not deleted.');
    if (!requestedRoom || !roomCapabilities(requestedRoom.state, true).canDelete) throw new Error('Only a closed room can be deleted.');
    try {
      const result = await rpc.call('room.delete', { room_id: roomId, confirm: true });
      if (!isDeleteRoomReceiptDto(result) || result.room_id !== roomId) throw new Error('daemon returned invalid deletion confirmation');
      deletedRoomIdsRef.current.add(roomId);
      selectionGeneration.current += 1;
      selectedPoller.current?.stop();
      replaceRooms(roomsRef.current.filter((room) => room.room_id !== roomId));
      updateSelectedRoom(undefined);
      setSelectedRoomId(undefined);
      selectedRoomIdRef.current = undefined;
      setParticipants([]);
      historyByRoomRef.current = Object.fromEntries(Object.entries(historyByRoomRef.current).filter(([key]) => key !== roomId));
      setHistoryByRoom(historyByRoomRef.current);
      composerByRoomRef.current = Object.fromEntries(Object.entries(composerByRoomRef.current).filter(([key]) => key !== roomId));
      setComposerByRoom(composerByRoomRef.current);
      setHistoryReadyByRoom((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== roomId)));
      setDeleteOpen(false);
      setContextOpen(false);
      setNotice(`Room “${roomId}” was deleted from this host. Remote copies and backups were not purged.`);
      history.replaceState(null, '', `${location.pathname}${location.search}#/`);
      void listPoller.current?.refresh();
    } catch (failure) { reportFailure(failure, 'Delete room failed'); throw failure; }
  }, [replaceRooms, reportFailure, rpc, updateSelectedRoom]);

  return (
    <div className="cowork-app">
      <RoomRail rooms={rooms} selectedRoomId={selectedRoomId} connected={connected} open={railOpen} sheet={roomSheet} onClose={() => setRailOpen(false)} onCreate={(trigger) => { createTrigger.current = trigger; setCreateOpen(true); }} onSelect={selectRoom} />
      <RoomWorkspace room={activeRoom} records={activeRoom ? historyByRoom[activeRoom.room_id] ?? [] : []} historyReady={Boolean(activeRoom && historyReadyByRoom[activeRoom.room_id])} connected={connected === true} visible={!document.hidden} composerState={activeRoom ? composerByRoom[activeRoom.room_id] ?? EMPTY_COMPOSER : EMPTY_COMPOSER} onComposerDraft={activeRoom ? (draft) => updateComposer(activeRoom.room_id, (current) => ({ ...current, draft })) : undefined} onComposerSendAsRole={activeRoom ? (sendAsRole) => updateComposer(activeRoom.room_id, (current) => ({ ...current, sendAsRole, error: undefined })) : undefined} onOpenRooms={() => setRailOpen(true)} onOpenContext={() => setContextOpen(true)} onSettings={(trigger) => { settingsTrigger.current = trigger; setSettingsOpen(true); }} onSendMessage={activeRoom ? (text) => sendMessage(activeRoom.room_id, text) : undefined} />
      <RoomContext room={activeRoom} participants={participants} archiveCount={activeRoom ? historyByRoom[activeRoom.room_id]?.length ?? 0 : 0} connected={connected === true} tab={contextTab} open={contextOpen} drawer={contextDrawer} panelRef={contextPanel} onTab={setContextTab} onClose={() => setContextOpen(false)} onCreateInvite={activeRoom ? (input) => createInvite(activeRoom.room_id, input) : undefined} onRevokeInvite={activeRoom ? (inviteId) => revokeInvite(activeRoom.room_id, inviteId) : undefined} onRecoverInvites={activeRoom ? () => recoverInvites(activeRoom.room_id) : undefined} onRequestClose={(trigger) => { closeTrigger.current = trigger; setCloseOpen(true); }} onRequestDelete={(trigger) => { deleteTrigger.current = trigger; setDeleteOpen(true); }} />
      {((roomSheet && railOpen) || (contextDrawer && contextOpen)) && <button className="responsive-scrim" type="button" aria-label="Close open panel" onClick={() => { setRailOpen(false); setContextOpen(false); }} />}

      {connected === false && <div className="disconnect-banner" role="status"><strong>Disconnected</strong><span>Loaded data remains visible. Mutations are disabled until the daemon answers.</span></div>}
      {banner && <div className="error-banner" role="alert"><span>{banner}</span><button type="button" onClick={() => setBanner(undefined)} aria-label="Dismiss error">×</button></div>}
      {notice && <div className="notice-banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice(undefined)} aria-label="Dismiss notice">×</button></div>}

      <CreateRoomDialog open={createOpen} connected={connected === true} restoreFocus={createTrigger.current} fallbackFocus={focusContextPanel} onClose={() => setCreateOpen(false)} onCreate={createRoom} />
      {activeRoom && settingsOpen && <SettingsDialog key={activeRoom.room_id} room={activeRoom} open connected={connected === true} capable={roomCapabilities(activeRoom.state, connected === true).canEditSettings} restoreFocus={settingsTrigger.current} onClose={() => setSettingsOpen(false)} onSave={(changes) => saveSettings(activeRoom.room_id, changes)} />}
      {activeRoom && closeOpen && <CloseRoomDialog key={`close:${activeRoom.room_id}`} room={activeRoom} open connected={connected === true} capable={roomCapabilities(activeRoom.state, connected === true).canClose} restoreFocus={closeTrigger.current} onClose={() => setCloseOpen(false)} onConfirm={() => closeRoom(activeRoom.room_id)} />}
      {activeRoom && deleteOpen && <DeleteRoomDialog key={`delete:${activeRoom.room_id}`} room={activeRoom} open connected={connected === true} capable={roomCapabilities(activeRoom.state, connected === true).canDelete} restoreFocus={deleteTrigger.current} onClose={() => setDeleteOpen(false)} onConfirm={() => deleteRoom(activeRoom.room_id)} />}
      {inviteReceiptVaults[0] && <InviteReceiptDialog vault={inviteReceiptVaults[0]} connected={connected === true} canConfirm={(receipt) => {
        const room = rooms.find((candidate) => candidate.room_id === receipt.room_id);
        return Boolean(room && canConfirmRecovery(room, receipt));
      }} onClose={() => setInviteReceiptVaults((current) => current.slice(1))} onConfirm={confirmRecovery} />}
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

const EMPTY_COMPOSER: RoomComposerState = { draft: '', pending: false };

function messageFailure(failure: unknown): string {
  if (failure instanceof RpcError && failure.outcomeUnknown) {
    return `The message request did not receive a confirmation, so its outcome is unknown. Your draft is retained. ${failure.message}`;
  }
  return failure instanceof Error ? failure.message : 'Message send failed.';
}

function canRevokeInvite(state: RoomDto['invites'][number]['state']): boolean {
  return state === 'live' || state === 'replacement_required' || state === 'receipt_pending';
}

function canConfirmRecovery(room: RoomDto, receipt: InviteReceiptDto): boolean {
  if (!roomCapabilities(room.state, true).canRecoverInvite || receipt.recovery_of === undefined) return false;
  const source = room.invites.find((invite) => invite.invite_id === receipt.recovery_of);
  if (!source
    || source.mode !== receipt.invite.mode
    || source.role !== receipt.invite.role
    || source.min_accepts !== receipt.invite.min_accepts) return false;
  const replacement = room.invites.find((invite) => invite.invite_id === receipt.invite.invite_id);
  if (!replacement) return source.state === 'replacement_required';
  if (replacement.recovery_of !== source.invite_id
    || replacement.mode !== source.mode
    || replacement.role !== source.role
    || replacement.min_accepts !== source.min_accepts) return false;
  if (replacement.state === 'receipt_pending') {
    return source.state === 'replacement_required'
      && replacement.recovery_confirmed === false
      && replacement.accepted_cids.length === 0;
  }
  return source.state === 'revoked'
    && replacement.recovery_confirmed === true
    && (replacement.state === 'live'
      || replacement.state === 'consumed'
      || replacement.state === 'replacement_required'
      || replacement.state === 'revoked');
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
