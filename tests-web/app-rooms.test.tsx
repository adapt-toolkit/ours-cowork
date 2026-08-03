import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import type { RoomDto } from '../web/src/api/types';

const AT = '2026-08-03T00:00:00.000Z';

function room(roomId: string, goal: string, state: RoomDto['state']): RoomDto {
  return {
    version: 1,
    room_id: roomId,
    identity_name: `cowork-room-${roomId}`,
    identity_cid: `cid-${roomId}`,
    mission: { goal, briefing: `${goal} briefing` },
    state,
    invites: state === 'closed' ? [] : [{
      invite_id: `invite-${roomId}`,
      mode: 'public',
      role: 'builder',
      min_accepts: 2,
      accepted_cids: ['cid-alice'],
      state: 'live',
      created_at: AT,
    }],
    seats: state === 'closed' ? [] : [{
      identity: 'cid-alice', display_name: 'Alice', role: 'builder',
      invite_id: `invite-${roomId}`, accepted_at: AT,
    }],
    created_at: AT,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CoworkApp room orchestration', () => {
  beforeEach(() => {
    location.hash = '';
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('removes closed responsive drawers from accessibility and tab order while keeping desktop context available', async () => {
    vi.useRealTimers();
    const release = room('r1', 'Release coordination', 'active');
    const call = vi.fn(async (method: string) => method === 'room.list' ? [release] : release);
    const user = userEvent.setup();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = matchMediaAt(700);
    try {
      const { container, unmount } = render(<CoworkApp rpc={{ call } as RpcClient} />);
      await screen.findByText('Release coordination');
      const rail = container.querySelector('.room-rail');
      const context = container.querySelector('.room-context');
      expect(rail).toHaveAttribute('aria-hidden', 'true');
      expect(rail).toHaveAttribute('hidden');
      expect(context).toHaveAttribute('aria-hidden', 'true');
      expect(context).toHaveAttribute('hidden');
      expect(within(rail as HTMLElement).getByRole('button', { name: 'Create room', hidden: true })).not.toBeVisible();
      const roomSheetTrigger = screen.getByRole('button', { name: 'Open rooms' });
      roomSheetTrigger.focus();
      await user.tab();
      expect(rail).not.toContainElement(document.activeElement as HTMLElement);
      expect(context).not.toContainElement(document.activeElement as HTMLElement);

      await user.click(roomSheetTrigger);
      expect(rail).not.toHaveAttribute('hidden');
      await user.click(screen.getByText('Release coordination'));
      expect(rail).toHaveAttribute('hidden');
      await user.click(await screen.findByRole('button', { name: 'Context' }));
      expect(context).not.toHaveAttribute('hidden');
      expect(screen.getByRole('tab', { name: 'State' })).toBeVisible();
      unmount();

      window.matchMedia = matchMediaAt(1_200);
      const desktop = render(<CoworkApp rpc={{ call } as RpcClient} />);
      const desktopContext = desktop.container.querySelector('.room-context');
      expect(desktopContext).not.toHaveAttribute('aria-hidden');
      expect(desktopContext).not.toHaveAttribute('hidden');
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.useFakeTimers({ shouldAdvanceTime: true });
    }
  });
  afterEach(() => vi.useRealTimers());

  it('groups rooms, hash-routes selection, and refreshes the list every five seconds', async () => {
    const release = room('r1', 'Release coordination', 'active');
    const archive = room('r2', 'Finished migration', 'closed');
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [release, archive];
      if (method === 'room.show' && params.room_id === 'r1') return release;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Release coordination')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Open rooms' })).getByText('Active')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Closed rooms' })).getByText('Closed')).toBeVisible();
    expect(screen.getByText('1 accepted · 1 needed')).toBeVisible();

    await user.click(screen.getByText('Release coordination'));
    expect(location.hash).toBe('#/rooms/r1');
    expect(await screen.findByRole('heading', { name: 'Release coordination' })).toBeVisible();

    const before = call.mock.calls.filter(([method]) => method === 'room.list').length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(call.mock.calls.filter(([method]) => method === 'room.list')).toHaveLength(before + 1);
  });

  it('preserves loaded room data and disables mutations when list polling disconnects', async () => {
    const release = room('r1', 'Release coordination', 'active');
    let listCalls = 0;
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') {
        listCalls += 1;
        if (listCalls > 1) throw new Error('offline');
        return [release];
      }
      if (method === 'room.show') return release;
      throw new Error(`unexpected ${method}`);
    });

    render(<CoworkApp rpc={{ call } as RpcClient} />);
    expect(await screen.findByText('Release coordination')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.getByText('Release coordination')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Disconnected');
    expect(screen.getByRole('button', { name: 'Create room' })).toBeDisabled();
  });

  it('ignores a previous room response that resolves after the current selection', async () => {
    const first = room('r1', 'First mission', 'active');
    const second = room('r2', 'Second mission', 'provisioning');
    const lateFirst = deferred<RoomDto>();
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show' && params.room_id === 'r1') return lateFirst.promise;
      if (method === 'room.show' && params.room_id === 'r2') return Promise.resolve(second);
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByText('First mission'));
    await user.click(screen.getByText('Second mission'));
    expect(await screen.findByRole('heading', { name: 'Second mission' })).toBeVisible();

    lateFirst.resolve(first);
    await act(async () => lateFirst.promise);
    expect(screen.getByRole('heading', { name: 'Second mission' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'First mission' })).not.toBeInTheDocument();
  });
});

function matchMediaAt(width: number): typeof window.matchMedia {
  return vi.fn((query: string) => {
    const maximum = /max-width:\s*(\d+)px/.exec(query);
    const matches = maximum ? width <= Number(maximum[1]) : false;
    return {
      matches,
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
