import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import { RpcError } from '../web/src/api/rpc';
import type { RoomDto } from '../web/src/api/types';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';

function createdRoom(): RoomDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    room_name: 'Launch room',
    identity_name: `cowork-room-${ROOM_ID}`,
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'a'.repeat(65) } });
    expect(screen.getByText('Name must be at most 64 characters.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'hidden\u200bname' } });
    expect(screen.getByText('Name cannot contain control or format characters.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Cafe\u0301 launch  ' } });
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: '🤖'.repeat(65_537) } });
    fireEvent.change(screen.getByLabelText('Briefing'), { target: { value: 'Briefing' } });
    expect(screen.getByText('Goal must be at most 262144 UTF-8 bytes.')).toBeVisible();

    await user.clear(screen.getByLabelText('Goal'));
    await user.type(screen.getByLabelText('Goal'), '  Release coordination  ');
    await user.clear(screen.getByLabelText('Briefing'));
    await user.type(screen.getByLabelText('Briefing'), '  Keep deploy owners aligned  ');
    const invoker = screen.getByRole('button', { name: 'Create room' });
    const submit = screen.getByRole('button', { name: 'Create mission room' });
    await user.click(submit);

    expect(call).toHaveBeenCalledWith('room.create', {
      name: 'Café launch', goal: 'Release coordination', briefing: 'Keep deploy owners aligned',
    });
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Creating room…' })).toBeDisabled();

    await user.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    invoker.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByLabelText('Briefing')).toHaveFocus();

    pending.resolve(createdRoom());
    await act(async () => pending.promise);
    expect(invoker).toHaveFocus();
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
    await user.type(screen.getByLabelText('Name'), 'Launch room');
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
    expect(location.hash).toBe(`#/rooms/${ROOM_ID}`);
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(2);
  });

  it('keeps an open create form and issues no RPC when the daemon disconnects', async () => {
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list' && disconnected) throw new Error('offline');
      if (method === 'room.list') return [];
      if (method === 'room.create') return createdRoom();
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    await user.type(screen.getByLabelText('Name'), 'Retained room');
    await user.type(screen.getByLabelText('Goal'), 'Retained create goal');
    await user.type(screen.getByLabelText('Briefing'), 'Retained create briefing');

    disconnected = true;
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Create is unavailable because the daemon disconnected/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create mission room' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Goal').closest('form')!);
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(0);
    expect(screen.getByLabelText('Goal')).toHaveValue('Retained create goal');
    expect(screen.getByLabelText('Briefing')).toHaveValue('Retained create briefing');
    expect(screen.getByRole('dialog', { name: 'Create mission room' })).toBeVisible();
  });

  it('hands confirmed mobile create focus to visible Invite context while cancel restores the open sheet trigger', async () => {
    const target = createdRoom();
    let created = false;
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return created ? [target] : [];
      if (method === 'room.create') { created = true; return target; }
      if (method === 'room.show') return target;
      throw new Error(`unexpected ${method}`);
    });
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = matchMediaAt(700);
    try {
      const user = userEvent.setup();
      const { container } = render(<CoworkApp rpc={{ call } as RpcClient} />);
      await user.click(await screen.findByRole('button', { name: 'Open rooms' }));
      const create = screen.getByRole('button', { name: 'Create room' });

      await user.click(create);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(create).toHaveFocus();
      expect(container.querySelector('.room-rail')).not.toHaveAttribute('hidden');

      await user.click(create);
      await user.type(screen.getByLabelText('Name'), 'Launch room');
      await user.type(screen.getByLabelText('Goal'), 'Release coordination');
      await user.type(screen.getByLabelText('Briefing'), 'Keep deploy owners aligned');
      await user.click(screen.getByRole('button', { name: 'Create mission room' }));

      expect(await screen.findByRole('tab', { name: 'Invite', selected: true })).toBeVisible();
      const context = container.querySelector('.room-context') as HTMLElement;
      expect(context).not.toHaveAttribute('hidden');
      expect(context).toHaveFocus();
      expect(create).not.toHaveFocus();
      expect(document.body).not.toHaveFocus();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
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
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    await user.type(screen.getByLabelText('Status (optional)'), 'ready');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(call).toHaveBeenCalledWith('room.settings', { room_id: ROOM_ID, status: 'ready' });
  });

  it('normalizes a changed friendly name through settings', async () => {
    const target = createdRoom();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.settings') return { ...target, room_name: 'Café planning' };
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), '  Cafe\u0301 planning  ');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(call).toHaveBeenCalledWith('room.settings', { room_id: ROOM_ID, name: 'Café planning' });
  });

  it('preserves persisted whitespace and submits only the exact changed setting', async () => {
    const target = {
      ...createdRoom(),
      mission: { goal: '  Release coordination  ', briefing: '\nKeep deploy owners aligned\n' },
      status: '  staged  ',
    };
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.settings') return target;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    expect(screen.getByLabelText('Goal')).toHaveValue('  Release coordination  ');
    expect(screen.getByLabelText('Briefing')).toHaveValue('\nKeep deploy owners aligned\n');
    expect(screen.getByLabelText('Status (optional)')).toHaveValue('  staged  ');
    expect(screen.getByText('24 / 262144 bytes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Status (optional)'), { target: { value: '  ready now  ' } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(call).toHaveBeenCalledWith('room.settings', { room_id: ROOM_ID, status: '  ready now  ' });
  });

  it('discards canceled settings drafts and reopens from the latest room DTO', async () => {
    let target = createdRoom();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list' || method === 'room.show') return method === 'room.list' ? [target] : target;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    const settings = await screen.findByRole('button', { name: 'Room settings' });
    await user.click(settings);
    await user.clear(screen.getByLabelText('Goal'));
    await user.type(screen.getByLabelText('Goal'), 'Canceled draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    target = { ...target, mission: { ...target.mission, goal: 'Server-refreshed goal' } };
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('Server-refreshed goal', { selector: '.mission-strip p' });
    await user.click(settings);
    expect(screen.getByLabelText('Goal')).toHaveValue('Server-refreshed goal');
    expect(within(screen.getByRole('dialog', { name: 'Room settings' })).getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });

  it.each(['disconnect', 'lifecycle'] as const)('retains an open settings form and issues no RPC after a %s capability change', async (change) => {
    let target: RoomDto = { ...createdRoom(), state: 'active' };
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.settings') return target;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    await user.type(screen.getByLabelText('Status (optional)'), 'retained status');

    if (change === 'disconnect') disconnected = true;
    else target = { ...target, state: 'closing' };
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Settings are unavailable because the connection or room lifecycle changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Goal').closest('form')!);
    expect(call.mock.calls.filter(([method]) => method === 'room.settings')).toHaveLength(0);
    expect(screen.getByLabelText('Status (optional)')).toHaveValue('retained status');
    expect(screen.getByRole('dialog', { name: 'Room settings' })).toBeVisible();
  });
});

function matchMediaAt(width: number): typeof window.matchMedia {
  return vi.fn((query: string) => {
    const maximum = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: maximum ? width <= Number(maximum[1]) : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as MediaQueryList;
  });
}
