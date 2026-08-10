import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RpcError } from '../web/src/api/rpc';
import { CoworkApp, type RpcClient } from '../web/src/App';
import type { MessageRecordDto, RoomDto } from '../web/src/api/types';
import { RoomComposer } from '../web/src/components/RoomComposer';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('authoritative room composer', () => {
  it('is active-only and disconnected-safe', () => {
    const { rerender } = render(<ControlledComposer roomState="provisioning" connected onSend={vi.fn()} />);
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    rerender(<ControlledComposer roomState="active" connected={false} onSend={vi.fn()} />);
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
  });

  it('uses Enter to issue exactly one request, disables pending input, and clears only after confirmation', async () => {
    const pending = deferred<void>();
    const onSend = vi.fn(() => pending.promise);
    const user = userEvent.setup();
    render(<ControlledComposer roomState="active" connected onSend={onSend} />);
    const input = screen.getByLabelText('Message the room');
    await user.type(input, 'Authoritative update');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Authoritative update');
    expect(input).toBeDisabled();
    expect(input).toHaveValue('Authoritative update');
    expect(screen.queryByText('Authoritative update', { selector: '.chat-row__text' })).not.toBeInTheDocument();

    await act(async () => { pending.resolve(); await pending.promise; });
    expect(input).toHaveValue('');
  });

  it('uses Shift+Enter for a newline and preserves a failed or outcome-unknown draft', async () => {
    const onSend = vi.fn()
      .mockRejectedValueOnce(new Error('room rejected the message'))
      .mockRejectedValueOnce(new RpcError('timeout', 'deadline elapsed', true));
    const user = userEvent.setup();
    render(<ControlledComposer roomState="active" connected onSend={onSend} />);
    const input = screen.getByLabelText('Message the room');

    await user.type(input, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('line one\n');
    await user.type(input, 'line two');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('room rejected the message');
    expect(input).toHaveValue('line one\nline two');

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/outcome is unknown/i);
    expect(input).toHaveValue('line one\nline two');
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('posts once without an optimistic row, then refreshes history immediately after authoritative confirmation', async () => {
    const target: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'Release coordination', identity_name: 'cowork-room-room-1', identity_cid: 'cid-room',
      mission: { goal: 'Release coordination', briefing: 'Coordinate carefully' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    const confirmed: MessageRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID, author: { identity: 'cid-room', display_name: 'cowork-room-room-1', role: 'room' },
      category: 'chat', text: 'Publish only from history', recipient_identities: [],
    };
    const pending = deferred<MessageRecordDto>();
    let sent = false;
    const call = vi.fn((method: string) => {
      if (method === 'room.list') return Promise.resolve([target]);
      if (method === 'room.show') return Promise.resolve(target);
      if (method === 'room.participants') return Promise.resolve([]);
      if (method === 'room.history') return Promise.resolve(sent ? [confirmed] : []);
      if (method === 'room.message') return pending.promise.then((record) => { sent = true; return record; });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const input = await screen.findByLabelText('Message the room');
    await user.type(input, confirmed.text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toEqual([
      ['room.message', { room_id: ROOM_ID, text: confirmed.text }],
    ]);
    expect(screen.queryByText(confirmed.text, { selector: '.chat-row__text' })).not.toBeInTheDocument();
    pending.resolve(confirmed);
    expect(await screen.findByText(confirmed.text, { selector: '.chat-row__text' })).toBeVisible();
    expect(input).toHaveValue('');
    expect(call.mock.calls.filter(([method]) => method === 'room.history').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps a pending send with its source room and refreshes only that room after navigation', async () => {
    const secondRoomId = '01jz6y7n8p9q0r1s2t3v4w5x72';
    const first = {
      version: 1, room_id: ROOM_ID, room_name: 'First mission', identity_name: 'cowork-room-one', identity_cid: 'cid-one',
      mission: { goal: 'First mission', briefing: 'First briefing' }, state: 'active' as const,
      invites: [], seats: [], created_at: AT,
    };
    const second = {
      ...first, room_id: secondRoomId, room_name: 'Second mission', identity_name: 'cowork-room-two', identity_cid: 'cid-two',
      mission: { goal: 'Second mission', briefing: 'Second briefing' },
    };
    const text = 'Source-room authoritative update';
    const confirmed: MessageRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID, author: { identity: first.identity_cid, display_name: first.identity_name, role: 'room' },
      category: 'chat', text, recipient_identities: [],
    };
    const pending = deferred<MessageRecordDto>();
    let confirmedReady = false;
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show') return Promise.resolve(params.room_id === ROOM_ID ? first : second);
      if (method === 'room.participants') return Promise.resolve([]);
      if (method === 'room.history') return Promise.resolve(params.room_id === ROOM_ID && confirmedReady ? [confirmed] : []);
      if (method === 'room.message') return pending.promise.then((record) => { confirmedReady = true; return record; });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const firstInput = await screen.findByLabelText('Message the room');
    await user.type(firstInput, text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.click(screen.getByText('Second mission'));
    const secondInput = await screen.findByLabelText('Message the room');
    expect(secondInput).toHaveValue('');
    await user.type(secondInput, 'Second-room draft');
    const secondHistoryBefore = call.mock.calls.filter(([method, params]) => method === 'room.history' && params.room_id === secondRoomId).length;
    const firstHistoryBefore = call.mock.calls.filter(([method, params]) => method === 'room.history' && params.room_id === ROOM_ID).length;

    pending.resolve(confirmed);
    await act(async () => pending.promise);
    await vi.waitFor(() => expect(call.mock.calls.filter(([method, params]) => method === 'room.history' && params.room_id === ROOM_ID).length).toBeGreaterThan(firstHistoryBefore));
    expect(call.mock.calls.filter(([method, params]) => method === 'room.history' && params.room_id === secondRoomId)).toHaveLength(secondHistoryBefore);
    expect(secondInput).toHaveValue('Second-room draft');
    expect(screen.queryByText(text, { selector: '.chat-row__text' })).not.toBeInTheDocument();

    await user.click(screen.getByText('First mission'));
    expect(await screen.findByText(text, { selector: '.chat-row__text' })).toBeVisible();
    expect(screen.getByLabelText('Message the room')).toHaveValue('');
  });

  it('allows one concurrent pending send per room and isolates their completion state', async () => {
    const secondRoomId = '01jz6y7n8p9q0r1s2t3v4w5x72';
    const first: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'First concurrent mission', identity_name: 'cowork-room-one', identity_cid: 'cid-one',
      mission: { goal: 'First concurrent mission', briefing: 'First concurrent briefing' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    const second: RoomDto = {
      ...first, room_id: secondRoomId, room_name: 'Second concurrent mission', identity_name: 'cowork-room-two', identity_cid: 'cid-two',
      mission: { goal: 'Second concurrent mission', briefing: 'Second concurrent briefing' },
    };
    const firstText = 'First room pending text';
    const secondText = 'Second room pending text';
    const firstPending = deferred<MessageRecordDto>();
    const secondPending = deferred<MessageRecordDto>();
    const firstConfirmation: MessageRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID,
      author: { identity: first.identity_cid, display_name: first.identity_name, role: 'room' },
      category: 'chat', text: firstText, recipient_identities: [],
    };
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show') return Promise.resolve(params.room_id === ROOM_ID ? first : second);
      if (method === 'room.participants' || method === 'room.history') return Promise.resolve([]);
      if (method === 'room.message') return params.room_id === ROOM_ID ? firstPending.promise : secondPending.promise;
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.type(await screen.findByLabelText('Message the room'), firstText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.click(screen.getByText('Second concurrent mission'));
    await user.type(await screen.findByLabelText('Message the room'), secondText);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(call.mock.calls.filter(([method]) => method === 'room.message').map(([, params]) => params)).toEqual([
      { room_id: ROOM_ID, text: firstText },
      { room_id: secondRoomId, text: secondText },
    ]);
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
    expect(screen.getByLabelText('Message the room')).toHaveValue(secondText);
    await user.click(screen.getByText('First concurrent mission'));
    expect(await screen.findByLabelText('Message the room')).toBeDisabled();
    expect(screen.getByLabelText('Message the room')).toHaveValue(firstText);

    await user.click(screen.getByText('Second concurrent mission'));
    secondPending.reject(new Error('second room rejected independently'));
    await act(async () => { try { await secondPending.promise; } catch { /* asserted below */ } });
    expect(await screen.findByRole('alert')).toHaveTextContent('second room rejected independently');
    expect(screen.getByLabelText('Message the room')).toHaveValue(secondText);

    await user.click(screen.getByText('First concurrent mission'));
    firstPending.resolve(firstConfirmation);
    await act(async () => firstPending.promise);
    expect(await screen.findByLabelText('Message the room')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByText('Second concurrent mission'));
    expect(await screen.findByLabelText('Message the room')).toHaveValue(secondText);
    expect(screen.getByRole('alert')).toHaveTextContent('second room rejected independently');
    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toHaveLength(2);
  });

  it.each([
    ['confirmed failure', new Error('room rejected the message'), /room rejected the message/i],
    ['unknown outcome', new RpcError('timeout', 'deadline elapsed', true), /outcome is unknown/i],
  ])('isolates a deferred %s draft and error across room switches', async (_label, failure, expectedError) => {
    const secondRoomId = '01jz6y7n8p9q0r1s2t3v4w5x72';
    const first: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'First mission', identity_name: 'cowork-room-one', identity_cid: 'cid-one',
      mission: { goal: 'First mission', briefing: 'First briefing' }, state: 'active', invites: [], seats: [], created_at: AT,
    };
    const second: RoomDto = {
      ...first, room_id: secondRoomId, room_name: 'Second mission', identity_name: 'cowork-room-two', identity_cid: 'cid-two',
      mission: { goal: 'Second mission', briefing: 'Second briefing' },
    };
    const pending = deferred<MessageRecordDto>();
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show') return Promise.resolve(params.room_id === ROOM_ID ? first : second);
      if (method === 'room.participants' || method === 'room.history') return Promise.resolve([]);
      if (method === 'room.message') return pending.promise;
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.type(await screen.findByLabelText('Message the room'), 'First-room retained draft');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await user.click(screen.getByText('Second mission'));
    await user.type(await screen.findByLabelText('Message the room'), 'Second-room retained draft');
    await user.click(screen.getByText('First mission'));
    expect(await screen.findByLabelText('Message the room')).toHaveValue('First-room retained draft');
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
    await user.click(screen.getByText('Second mission'));

    pending.reject(failure);
    await act(async () => { try { await pending.promise; } catch { /* asserted in UI */ } });
    expect(screen.getByLabelText('Message the room')).toHaveValue('Second-room retained draft');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByText('First mission'));
    expect(await screen.findByRole('alert')).toHaveTextContent(expectedError);
    expect(screen.getByLabelText('Message the room')).toHaveValue('First-room retained draft');
    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toHaveLength(1);
  });

  it('drops pending composer state safely when its room is deleted before the send resolves', async () => {
    let current: RoomDto | undefined = {
      version: 1, room_id: ROOM_ID, room_name: 'Deletion race', identity_name: 'cowork-room-one', identity_cid: 'cid-one',
      mission: { goal: 'Deletion race', briefing: 'Deletion briefing' }, state: 'active', invites: [], seats: [], created_at: AT,
    };
    const requestedRoom = current;
    const confirmed: MessageRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID, author: { identity: requestedRoom.identity_cid, display_name: requestedRoom.identity_name, role: 'room' },
      category: 'chat', text: 'Pending through delete', recipient_identities: [],
    };
    const pending = deferred<MessageRecordDto>();
    const call = vi.fn((method: string) => {
      if (method === 'room.list') return Promise.resolve(current ? [current] : []);
      if (method === 'room.show') return current ? Promise.resolve(current) : Promise.reject(new Error('missing'));
      if (method === 'room.participants' || method === 'room.history') return Promise.resolve([]);
      if (method === 'room.message') return pending.promise;
      if (method === 'room.delete') { current = undefined; return Promise.resolve({ version: 1, room_id: ROOM_ID, deleted: true, scope: 'this_host' }); }
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.type(await screen.findByLabelText('Message the room'), confirmed.text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    current = { ...requestedRoom, state: 'closed', closed_at: AT };
    fireEvent(document, new Event('visibilitychange'));
    await user.click(await screen.findByRole('button', { name: 'Delete room' }));
    await user.type(screen.getByLabelText('Type exact room ID to delete'), ROOM_ID);
    await user.click(screen.getByRole('button', { name: 'Delete local archive' }));
    expect(await screen.findByRole('heading', { name: 'Select a room' })).toBeVisible();
    const targetHistoryBefore = call.mock.calls.filter(([method]) => method === 'room.history').length;

    pending.resolve(confirmed);
    await act(async () => pending.promise);
    expect(screen.getByRole('heading', { name: 'Select a room' })).toBeVisible();
    expect(call.mock.calls.filter(([method]) => method === 'room.history')).toHaveLength(targetHistoryBefore);
  });

  it.each([
    ['extra key', (record: MessageRecordDto) => ({ ...record, injected: true })],
    ['bad message ULID', (record: MessageRecordDto) => ({ ...record, message_id: 'message-1' })],
    ['bad timestamp', (record: MessageRecordDto) => ({ ...record, at: '2026-08-03' })],
    ['bad record ID', (record: MessageRecordDto) => ({ ...record, record_id: `${ROOM_ID}:2` })],
    ['foreign union field', (record: MessageRecordDto) => ({ ...record, notified: true })],
  ])('retains the draft when message confirmation has a %s', async (_label, corrupt) => {
    const target: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'Release coordination', identity_name: 'cowork-room-room-1', identity_cid: 'cid-room',
      mission: { goal: 'Release coordination', briefing: 'Coordinate carefully' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    const confirmed: MessageRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID, author: { identity: 'cid-room', display_name: 'cowork-room-room-1', role: 'room' },
      category: 'chat', text: 'Keep this draft', recipient_identities: [],
    };
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.message') return corrupt(confirmed);
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const input = await screen.findByLabelText('Message the room');
    await user.type(input, confirmed.text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await within(input.closest('form')!).findByRole('alert')).toHaveTextContent(/invalid message confirmation/i);
    expect(input).toHaveValue(confirmed.text);
    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toHaveLength(1);
  });

  it('does not submit a retained draft after the selected room disconnects', async () => {
    const target: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'Release coordination', identity_name: 'cowork-room-room-1', identity_cid: 'cid-room',
      mission: { goal: 'Release coordination', briefing: 'Coordinate carefully' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.message') return {};
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const input = await screen.findByLabelText('Message the room');
    await user.type(input, 'Retain while offline');
    disconnected = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Loaded data remains visible/)).toBeVisible();
    expect(input).toBeDisabled();
    fireEvent.submit(input.closest('form')!);

    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toHaveLength(0);
    expect(input).toHaveValue('Retain while offline');
  });

  it('does not submit a retained draft after the selected room leaves active state', async () => {
    let target: RoomDto = {
      version: 1, room_id: ROOM_ID, room_name: 'Release coordination', identity_name: 'cowork-room-room-1', identity_cid: 'cid-room',
      mission: { goal: 'Release coordination', briefing: 'Coordinate carefully' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.message') return {};
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const input = await screen.findByLabelText('Message the room');
    await user.type(input, 'Retain while closing');
    target = { ...target, state: 'closing' };
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Room closure in progress/)).toBeVisible();
    expect(input).toBeDisabled();
    fireEvent.submit(input.closest('form')!);

    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toHaveLength(0);
    expect(input).toHaveValue('Retain while closing');
  });
});

function ControlledComposer({ roomState, connected, onSend }: {
  roomState: RoomDto['state']; connected: boolean; onSend(text: string): Promise<void>;
}) {
  const [state, setState] = React.useState({ draft: '', pending: false, error: undefined as string | undefined });
  return <RoomComposer roomState={roomState} connected={connected} state={state} onDraftChange={(draft) => setState((current) => ({ ...current, draft }))} onSend={async (text) => {
    setState((current) => ({ ...current, pending: true, error: undefined }));
    try {
      await onSend(text);
      setState((current) => ({ draft: current.draft === text ? '' : current.draft, pending: false, error: undefined }));
    } catch (failure) {
      const error = failure instanceof RpcError && failure.outcomeUnknown
        ? `The message request did not receive a confirmation, so its outcome is unknown. Your draft is retained. ${failure.message}`
        : failure instanceof Error ? failure.message : 'Message send failed.';
      setState((current) => ({ ...current, pending: false, error }));
    }
  }} />;
}
