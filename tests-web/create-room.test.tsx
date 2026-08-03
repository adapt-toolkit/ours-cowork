import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import { RpcError } from '../web/src/api/rpc';
import type { RoomDto } from '../web/src/api/types';

const AT = '2026-08-03T00:00:00.000Z';

function createdRoom(): RoomDto {
  return {
    version: 1,
    room_id: 'new-room',
    identity_name: 'cowork-room-new-room',
    identity_cid: 'cid-new-room',
    mission: { goal: 'Release coordination', briefing: 'Keep deploy owners aligned' },
    state: 'provisioning',
    invites: [],
    seats: [],
    created_at: AT,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('create and settings dialogs', () => {
  beforeEach(() => { location.hash = ''; });

  it('validates UTF-8 byte limits and performs exactly one unresolved create request', async () => {
    const pending = deferred<RoomDto>();
    const call = vi.fn((method: string) => method === 'room.list'
      ? Promise.resolve([])
      : pending.promise);
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: '🤖'.repeat(65_537) } });
    fireEvent.change(screen.getByLabelText('Briefing'), { target: { value: 'Briefing' } });
    expect(screen.getByText('Goal must be at most 262144 UTF-8 bytes.')).toBeVisible();

    await user.clear(screen.getByLabelText('Goal'));
    await user.type(screen.getByLabelText('Goal'), '  Release coordination  ');
    await user.clear(screen.getByLabelText('Briefing'));
    await user.type(screen.getByLabelText('Briefing'), '  Keep deploy owners aligned  ');
    await user.click(screen.getByRole('button', { name: 'Create mission room' }));

    expect(call).toHaveBeenCalledWith('room.create', {
      goal: 'Release coordination', briefing: 'Keep deploy owners aligned',
    });
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Creating room…' })).toBeDisabled();

    pending.resolve(createdRoom());
    await act(async () => pending.promise);
  });

  it('retains fields after an unknown outcome, then selects a confirmed room and opens Invite', async () => {
    let mode: 'fail' | 'success' = 'fail';
    const target = createdRoom();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return mode === 'success' ? [target] : [];
      if (method === 'room.create') {
        if (mode === 'fail') throw new RpcError('timeout', 'daemon did not answer', true);
        return target;
      }
      if (method === 'room.show') return target;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    await user.type(screen.getByLabelText('Goal'), 'Release coordination');
    await user.type(screen.getByLabelText('Briefing'), 'Keep deploy owners aligned');
    await user.click(screen.getByRole('button', { name: 'Create mission room' }));

    expect(await screen.findByText(/outcome is unknown/i)).toBeVisible();
    expect(screen.getByLabelText('Goal')).toHaveValue('Release coordination');
    expect(screen.getByLabelText('Briefing')).toHaveValue('Keep deploy owners aligned');

    mode = 'success';
    await user.click(screen.getByRole('button', { name: 'Create mission room' }));
    expect(await screen.findByRole('tab', { name: 'Invite', selected: true })).toBeVisible();
    expect(screen.getByText(/Add invitation requirements one at a time/)).toBeVisible();
    expect(location.hash).toBe('#/rooms/new-room');
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(2);
  });

  it('sends only dirty settings fields', async () => {
    const target = createdRoom();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.settings') return { ...target, status: 'ready' };
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = '#/rooms/new-room';
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    await user.type(screen.getByLabelText('Status (optional)'), 'ready');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(call).toHaveBeenCalledWith('room.settings', { room_id: 'new-room', status: 'ready' });
  });
});
