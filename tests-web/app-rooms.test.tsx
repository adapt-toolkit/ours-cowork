import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import type { RoomDto } from '../web/src/api/types';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ONE = '01jz6y7n8p9q0r1s2t3v4w5x70';
const ROOM_TWO = '01jz6y7n8p9q0r1s2t3v4w5x71';

function room(roomId: string, goal: string, state: RoomDto['state']): RoomDto {
  return {
    version: 1,
    room_id: roomId,
    room_name: goal,
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
    const release = room(ROOM_ONE, 'Release coordination', 'active');
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
    const release = { ...room(ROOM_ONE, 'Release coordination', 'active'), room_name: 'Launch bridge' };
    const archive = { ...room(ROOM_TWO, 'Finished migration', 'closed'), room_name: 'Migration archive' };
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [release, archive];
      if (method === 'room.show' && params.room_id === ROOM_ONE) return release;
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Launch bridge')).toBeVisible();
    expect(screen.getByText('Migration archive')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Open rooms' })).getByText('Active')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Closed rooms' })).getByText('Closed')).toBeVisible();
    expect(screen.getByText('1 accepted · 1 needed')).toBeVisible();

    await user.click(screen.getByText('Launch bridge'));
    expect(location.hash).toBe(`#/rooms/${ROOM_ONE}`);
    expect(await screen.findByRole('heading', { name: 'Launch bridge' })).toBeVisible();
    expect(screen.getByText('Release coordination', { selector: '.mission-strip p' })).toBeVisible();
    expect(screen.queryByText(release.identity_name)).not.toBeInTheDocument();
    expect(screen.getByText('Room name').nextElementSibling).toHaveTextContent('Launch bridge');

    const before = call.mock.calls.filter(([method]) => method === 'room.list').length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(call.mock.calls.filter(([method]) => method === 'room.list')).toHaveLength(before + 1);
  });

  it('loads a host history page with scoped messages and keeps rejection and relay rows in the archive', async () => {
    const release = room(ROOM_ONE, 'Thread archive room', 'active');
    const caller = 'A'.repeat(64), participant = '01jz6y7n8p9q0r1s2t3v4w5xa1';
    const threadId = '01jz6y7n8p9q0r1s2t3v4w5xt1';
    const common = { version: 1, room_id: ROOM_ONE, at: AT };
    const message = { ...common, kind: 'message', author: { identity: caller, display_name: 'Alice', role: 'builder' }, category: 'chat', recipient_identities: [caller] };
    const rows = [
      { ...message, seq: 1, record_id: `${ROOM_ONE}:1`, message_id: '01jz6y7n8p9q0r1s2t3v4w5xt0', text: 'Ordinary host message' },
      { ...message, seq: 2, record_id: `${ROOM_ONE}:2`, message_id: threadId, text: 'Thread: Review', scope: { thread_id: threadId }, thread_root: { schema_version: 1, thread_id: threadId, topic: 'Review', creator_participant_id: participant, members: [{ identity: caller, participant_id: participant }], idempotency_key: 'host-retry-key', fingerprint: '0'.repeat(64) } },
      { ...message, seq: 3, record_id: `${ROOM_ONE}:3`, message_id: '01jz6y7n8p9q0r1s2t3v4w5xt2', text: 'Scoped host reply', scope: { thread_id: threadId, parent_key: `message:${threadId}` }, source_reply_to: { wire_id: 'root-copy' } },
      { ...common, seq: 4, record_id: `${ROOM_ONE}:4`, kind: 'intake_rejection', source_kind: 'message', source_msg_id: 9, source_wire_id: 'rejected-wire', sender_identity: caller, sender_participant_id: participant, fingerprint: '0'.repeat(64), error: 'reply_target_unavailable', notification_attempt_claimed: true },
      { ...common, seq: 5, record_id: `${ROOM_ONE}:5`, kind: 'relay_result', message_id: threadId, intent_record_id: `${ROOM_ONE}:4`, recipient_identity: caller, status: 'skipped_reply_unavailable' },
    ];
    const { isHistoryDto } = await import('../web/src/api/types');
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [release];
      if (method === 'room.show') return release;
      if (method === 'room.participants') return release.seats;
      if (method === 'room.history') {
        expect(params.view).not.toBe('participant');
        expect(isHistoryDto(rows)).toBe(true);
        return rows.filter(row => row.seq > Number(params.after ?? 0));
      }
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByText('Thread archive room'));
    expect(await screen.findByText('Ordinary host message')).toBeVisible();
    expect(screen.getByText('Thread: Review')).toBeVisible();
    expect(screen.getByText('Scoped host reply')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Archive' }));
    expect(await screen.findByText(/host-retry-key/)).toBeVisible();
    expect(screen.getByText(/rejected-wire/)).toBeVisible();
    expect(screen.getAllByText(/skipped_reply_unavailable/).some(element => element.closest('[role="tabpanel"]'))).toBe(true);
  });

  it('preserves loaded room data and disables mutations when list polling disconnects', async () => {
    const release = room(ROOM_ONE, 'Release coordination', 'active');
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
    const first = room(ROOM_ONE, 'First mission', 'active');
    const second = room(ROOM_TWO, 'Second mission', 'provisioning');
    const lateFirst = deferred<RoomDto>();
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show' && params.room_id === ROOM_ONE) return lateFirst.promise;
      if (method === 'room.show' && params.room_id === ROOM_TWO) return Promise.resolve(second);
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
