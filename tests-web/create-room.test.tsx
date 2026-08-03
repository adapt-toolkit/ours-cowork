import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    const invoker = screen.getByRole('button', { name: 'Create room' });
    const submit = screen.getByRole('button', { name: 'Create mission room' });
    await user.click(submit);

    expect(call).toHaveBeenCalledWith('room.create', {
      goal: 'Release coordination', briefing: 'Keep deploy owners aligned',
    });
    expect(call.mock.calls.filter(([method]) => method === 'room.create')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Creating room…' })).toBeDisabled();

    await user.tab();
    expect(screen.getByLabelText('Goal')).toHaveFocus();
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
    location.hash = '#/rooms/new-room';
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    await user.type(screen.getByLabelText('Status (optional)'), 'ready');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(call).toHaveBeenCalledWith('room.settings', { room_id: 'new-room', status: 'ready' });
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
    location.hash = '#/rooms/new-room';
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    expect(screen.getByLabelText('Goal')).toHaveValue('  Release coordination  ');
    expect(screen.getByLabelText('Briefing')).toHaveValue('\nKeep deploy owners aligned\n');
    expect(screen.getByLabelText('Status (optional)')).toHaveValue('  staged  ');
    expect(screen.getByText('24 / 262144 bytes')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Status (optional)'), { target: { value: '  ready now  ' } });
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(call).toHaveBeenCalledWith('room.settings', { room_id: 'new-room', status: '  ready now  ' });
  });

  it('discards canceled settings drafts and reopens from the latest room DTO', async () => {
    let target = createdRoom();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list' || method === 'room.show') return method === 'room.list' ? [target] : target;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = '#/rooms/new-room';
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    const settings = await screen.findByRole('button', { name: 'Room settings' });
    await user.click(settings);
    await user.clear(screen.getByLabelText('Goal'));
    await user.type(screen.getByLabelText('Goal'), 'Canceled draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    target = { ...target, mission: { ...target.mission, goal: 'Server-refreshed goal' } };
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('heading', { name: 'Server-refreshed goal' });
    await user.click(settings);
    expect(screen.getByLabelText('Goal')).toHaveValue('Server-refreshed goal');
    expect(within(screen.getByRole('dialog', { name: 'Room settings' })).getByRole('button', { name: 'Save settings' })).toBeDisabled();
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
