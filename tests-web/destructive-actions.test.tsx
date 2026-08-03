import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import { RpcError } from '../web/src/api/rpc';
import type { CommunicationRecordDto, ParticipantDto, RoomDto } from '../web/src/api/types';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function room(state: RoomDto['state']): RoomDto {
  return {
    version: 1, room_id: ROOM_ID, identity_name: 'cowork-room-operations', identity_cid: 'cid-room',
    mission: { goal: 'Release coordination', briefing: 'Coordinate the release' }, state,
    invites: [], seats: [], created_at: AT,
    ...(state === 'closed' ? { closed_at: AT } : {}),
  };
}

describe('close and delete actions', () => {
  beforeEach(() => { location.hash = `#/rooms/${ROOM_ID}`; });

  it('offers close only before closed, requires title or ID, explains consequences, and submits once', async () => {
    const active = room('active');
    const closed = room('closed');
    let current = active;
    const closePending: { resolve?: (value: RoomDto) => void } = {};
    const call = vi.fn((method: string) => {
      if (method === 'room.list') return Promise.resolve([current]);
      if (method === 'room.show') return Promise.resolve(current);
      if (method === 'room.participants' || method === 'room.history') return Promise.resolve([]);
      if (method === 'room.close') return new Promise<RoomDto>((resolve) => { closePending.resolve = resolve; });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Close room' }));
    expect(screen.getByRole('dialog', { name: 'Close room' })).toHaveTextContent(/live packet state is removed/i);
    expect(screen.getByRole('dialog', { name: 'Close room' })).toHaveTextContent(/plaintext local archive remains/i);
    const confirm = screen.getByLabelText('Type room title or ID to close');
    await user.type(confirm, 'wrong');
    expect(screen.getByRole('button', { name: 'Close room permanently' })).toBeDisabled();
    await user.clear(confirm);
    await user.type(confirm, 'Release coordination');
    await user.click(screen.getByRole('button', { name: 'Close room permanently' }));
    await user.click(screen.getByRole('button', { name: 'Closing room…' }));
    expect(call.mock.calls.filter(([method]) => method === 'room.close')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Closing room…' })).toBeDisabled();

    current = closed;
    closePending.resolve?.(closed);
    expect(await screen.findByRole('button', { name: 'Delete room' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close room' })).not.toBeInTheDocument();
  });

  it('keeps an unknown close outcome visible with the confirmation retained and does not retry', async () => {
    const active = room('active');
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [active];
      if (method === 'room.show') return active;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.close') throw new RpcError('timeout', 'deadline elapsed', true);
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Close room' }));
    await user.type(screen.getByLabelText('Type room title or ID to close'), ROOM_ID);
    await user.click(screen.getByRole('button', { name: 'Close room permanently' }));
    expect(await screen.findByText(/outcome is unknown/i)).toBeVisible();
    expect(screen.getByLabelText('Type room title or ID to close')).toHaveValue(ROOM_ID);
    expect(screen.getByRole('heading', { name: 'Release coordination' })).toBeVisible();
    expect(call.mock.calls.filter(([method]) => method === 'room.close')).toHaveLength(1);
  });

  it('disables an open close confirmation after disconnect and performs no mutation', async () => {
    const active = room('active');
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [active];
      if (method === 'room.show') return active;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.close') return room('closed');
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Close room' }));
    const confirmation = screen.getByLabelText('Type room title or ID to close');
    await user.type(confirmation, ROOM_ID);

    disconnected = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Loaded data remains visible/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close room permanently' })).toBeDisabled();
    fireEvent.submit(confirmation.closest('form')!);
    expect(call.mock.calls.filter(([method]) => method === 'room.close')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Close room' })).toBeVisible();
    expect(confirmation).toHaveValue(ROOM_ID);
  });

  it('disables an open close confirmation when the room lifecycle advances', async () => {
    let current = room('active');
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.close') return room('closed');
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Close room' }));
    const confirmation = screen.getByLabelText('Type room title or ID to close');
    await user.type(confirmation, ROOM_ID);

    current = { ...current, state: 'closing' };
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Close is unavailable because the connection or room lifecycle changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close room permanently' })).toBeDisabled();
    fireEvent.submit(confirmation.closest('form')!);
    expect(call.mock.calls.filter(([method]) => method === 'room.close')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Close room' })).toBeVisible();
    expect(confirmation).toHaveValue(ROOM_ID);
  });

  it('offers delete only when closed, requires the exact ID, states scope precisely, and navigates only after a confirmed receipt', async () => {
    const closed = room('closed');
    let deleted = false;
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return deleted ? [] : [closed];
      if (method === 'room.show') return closed;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.delete') {
        deleted = true;
        return { version: 1, room_id: ROOM_ID, deleted: true, scope: 'this_host' };
      }
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Delete room' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete room' });
    expect(dialog).toHaveTextContent(/deletes the plaintext local archive and room metadata from this host/i);
    expect(dialog).toHaveTextContent(/does not purge remote copies/i);
    expect(dialog).toHaveTextContent(/does not securely erase/i);
    await user.type(screen.getByLabelText('Type exact room ID to delete'), 'Release coordination');
    expect(screen.getByRole('button', { name: 'Delete local archive' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Type exact room ID to delete'));
    await user.type(screen.getByLabelText('Type exact room ID to delete'), ROOM_ID);
    await user.click(screen.getByRole('button', { name: 'Delete local archive' }));

    expect(call).toHaveBeenCalledWith('room.delete', { room_id: ROOM_ID, confirm: true });
    expect(location.hash).toBe('#/');
    expect(await screen.findByRole('heading', { name: 'Select a room' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/deleted from this host/i);
  });

  it('never resurrects a confirmed deletion from late or future room reads', async () => {
    const closed = room('closed');
    const lateList = deferred<RoomDto[]>();
    const lateShow = deferred<RoomDto>();
    const lateParticipants = deferred<ParticipantDto[]>();
    const lateHistory = deferred<CommunicationRecordDto[]>();
    const participant: ParticipantDto = {
      identity: 'cid-late', display_name: 'Late Participant', role: 'builder',
      invite_id: 'invite-late', accepted_at: AT,
    };
    const record: CommunicationRecordDto = {
      version: 1, room_id: ROOM_ID, seq: 1, record_id: `${ROOM_ID}:1`, at: AT,
      kind: 'message', message_id: MESSAGE_ID,
      author: { identity: closed.identity_cid, display_name: closed.identity_name, role: 'room' },
      category: 'chat', text: 'Late deleted archive record', recipient_identities: [],
    };
    let listCalls = 0;
    const call = vi.fn((method: string) => {
      if (method === 'room.list') return ++listCalls === 1 ? Promise.resolve([closed]) : listCalls === 2 ? lateList.promise : Promise.resolve([closed]);
      if (method === 'room.show') return lateShow.promise;
      if (method === 'room.participants') return lateParticipants.promise;
      if (method === 'room.history') return lateHistory.promise;
      if (method === 'room.delete') return Promise.resolve({ version: 1, room_id: ROOM_ID, deleted: true, scope: 'this_host' });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await screen.findByRole('button', { name: 'Delete room' });
    await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'room.show')).toBe(true));
    fireEvent(document, new Event('visibilitychange'));
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'room.list')).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'Delete room' }));
    await user.type(screen.getByLabelText('Type exact room ID to delete'), ROOM_ID);
    await user.click(screen.getByRole('button', { name: 'Delete local archive' }));
    expect(await screen.findByRole('heading', { name: 'Select a room' })).toBeVisible();
    expect(location.hash).toBe('#/');

    lateList.resolve([closed]);
    lateShow.resolve(closed);
    lateParticipants.resolve([participant]);
    lateHistory.resolve([record]);
    await act(async () => Promise.all([lateList.promise, lateShow.promise, lateParticipants.promise, lateHistory.promise]));

    expect(screen.getByRole('heading', { name: 'Select a room' })).toBeVisible();
    expect(location.hash).toBe('#/');
    expect(screen.queryByText('Release coordination')).not.toBeInTheDocument();
    expect(screen.queryByText('Late Participant')).not.toBeInTheDocument();
    expect(screen.queryByText('Late deleted archive record')).not.toBeInTheDocument();

    const listCallsBeforeFuturePoll = call.mock.calls.filter(([method]) => method === 'room.list').length;
    fireEvent(document, new Event('visibilitychange'));
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'room.list').length).toBeGreaterThan(listCallsBeforeFuturePoll));
    expect(screen.queryByText('Release coordination')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select a room' })).toBeVisible();
    expect(location.hash).toBe('#/');
  });

  it('retains the closed-room view and exact confirmation after an outcome-unknown delete without retrying', async () => {
    const closed = room('closed');
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [closed];
      if (method === 'room.show') return closed;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.delete') throw new RpcError('timeout', 'deadline elapsed', true);
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Delete room' }));
    await user.type(screen.getByLabelText('Type exact room ID to delete'), ROOM_ID);
    await user.click(screen.getByRole('button', { name: 'Delete local archive' }));

    expect(await screen.findByText(/delete request did not receive a confirmation/i)).toBeVisible();
    expect(screen.getByLabelText('Type exact room ID to delete')).toHaveValue(ROOM_ID);
    expect(screen.getByRole('heading', { name: 'Release coordination' })).toBeVisible();
    expect(location.hash).toBe(`#/rooms/${ROOM_ID}`);
    expect(call.mock.calls.filter(([method]) => method === 'room.delete')).toHaveLength(1);
  });

  it('disables an open delete confirmation after disconnect and performs no mutation', async () => {
    const closed = room('closed');
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [closed];
      if (method === 'room.show') return closed;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.delete') return { version: 1, room_id: ROOM_ID, deleted: true, scope: 'this_host' };
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Delete room' }));
    const confirmation = screen.getByLabelText('Type exact room ID to delete');
    await user.type(confirmation, ROOM_ID);

    disconnected = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Loaded data remains visible/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete local archive' })).toBeDisabled();
    fireEvent.submit(confirmation.closest('form')!);
    expect(call.mock.calls.filter(([method]) => method === 'room.delete')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Delete room' })).toBeVisible();
    expect(confirmation).toHaveValue(ROOM_ID);
  });
});
