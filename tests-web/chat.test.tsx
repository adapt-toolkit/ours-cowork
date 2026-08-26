import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import type { CommunicationRecordDto, FileRecordDto, MessageRecordDto, RoomDto } from '../web/src/api/types';
import { ArchiveView } from '../web/src/components/ArchiveView';
import { ChatTimeline } from '../web/src/components/ChatTimeline';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ONE = '01jz6y7n8p9q0r1s2t3v4w5x70';
const ROOM_TWO = '01jz6y7n8p9q0r1s2t3v4w5x71';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x72';

function room(roomId = ROOM_ONE): RoomDto {
  const label = roomId === ROOM_ONE ? 'room-1' : 'room-2';
  return {
    version: 1, room_id: roomId, room_name: label, identity_name: `cowork-${label}`, identity_cid: `cid-${label}`,
    mission: { goal: `Goal ${label}`, briefing: `Briefing ${label}` }, state: 'active',
    invites: [], seats: [], created_at: AT,
  };
}

function message(seq: number, overrides: Partial<MessageRecordDto> = {}): MessageRecordDto {
  return {
    version: 1, room_id: ROOM_ONE, seq, record_id: `${ROOM_ONE}:${seq}`, at: AT,
    kind: 'message', message_id: MESSAGE_ID,
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
    category: 'chat', text: `message ${seq}`, recipient_identities: ['cid-room-1'], ...overrides,
  };
}

function relay(seq: number): CommunicationRecordDto {
  return {
    version: 1, room_id: ROOM_ONE, seq, record_id: `${ROOM_ONE}:${seq}`, at: AT,
    kind: 'relay_result', intent_record_id: `intent-${seq}`, message_id: MESSAGE_ID,
    recipient_identity: 'cid-alice', status: 'send_failed',
  };
}

function file(seq: number): FileRecordDto {
  return {
    version: 1, room_id: ROOM_ONE, seq, record_id: `${ROOM_ONE}:${seq}`, at: AT,
    kind: 'file', file_id: '01jz6y7n8p9q0r1s2t3v4w5x73',
    author: { identity: 'cid-alice', display_name: 'Alice', role: 'builder' },
    filename: 'proof.bin', mime: 'application/octet-stream', size: 1,
    sha256: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
    data_base64: 'QQ==', recipient_identities: ['cid-room-1'], source_file_id: seq,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('chat, events, and archive projections', () => {
  it('interleaves inert file cards by numeric seq, excludes relay rows, and distinguishes message voices', () => {
    render(<ChatTimeline roomId={ROOM_ONE} records={[
      message(10, { author: { identity: 'cid-room-1', display_name: 'Operations room', role: 'room' }, text: 'Room decision' }),
      relay(4),
      file(3),
      message(2, { text: 'Participant update' }),
      message(1, { category: 'briefing', text: 'Mission briefing' }),
    ]} historyReady visible />);

    const timeline = screen.getByRole('list', { name: 'Room communication' });
    expect(within(timeline).queryByText('send_failed')).not.toBeInTheDocument();
    expect(within(timeline).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Mission briefing'),
      expect.stringContaining('Participant update'),
      expect.stringContaining('proof.bin'),
      expect.stringContaining('Room decision'),
    ]);
    expect(screen.getAllByText('Mission briefing').at(-1)?.closest('li')).toHaveClass('chat-row--briefing');
    expect(screen.getByText('Participant update').closest('li')).toHaveClass('chat-row--participant');
    expect(screen.getByText('proof.bin').closest('li')).toHaveClass('chat-row--file');
    expect(screen.getByRole('button', { name: 'Download proof.bin' })).toBeVisible();
    expect(timeline).not.toHaveTextContent('QQ==');
    expect(screen.getByText('Room decision').closest('li')).toHaveClass('chat-row--room');
  });

  it('mounts only the newest 500 projected rows and reveals loaded history in 500-row increments', async () => {
    const user = userEvent.setup();
    render(<ChatTimeline roomId={ROOM_ONE} records={Array.from({ length: 1_200 }, (_, index) => message(index + 1))} historyReady visible />);

    expect(screen.getAllByRole('listitem')).toHaveLength(500);
    expect(screen.queryByText('message 700')).not.toBeInTheDocument();
    expect(screen.getByText('message 701')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 500 earlier' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1_000);
    expect(screen.getByText('message 201')).toBeVisible();
  });

  it('announces only additions that arrive after initial history while the selected room is visible', () => {
    const initial = [message(1)];
    const { rerender } = render(<ChatTimeline roomId={ROOM_ONE} records={initial} historyReady visible />);
    const live = screen.getByRole('status', { name: 'New room items' });
    expect(live).toHaveTextContent('');

    rerender(<ChatTimeline roomId={ROOM_ONE} records={[...initial, message(2)]} historyReady visible={false} />);
    expect(live).toHaveTextContent('');
    rerender(<ChatTimeline roomId={ROOM_ONE} records={[...initial, message(2), message(3)]} historyReady visible />);
    expect(live).toHaveTextContent('1 new message');

    rerender(<ChatTimeline roomId={ROOM_ONE} records={[...initial, message(2), message(3), file(4)]} historyReady visible />);
    expect(live).toHaveTextContent('1 new attachment');
    rerender(<ChatTimeline roomId={ROOM_ONE} records={[...initial, message(2), message(3), file(4), message(5), file(6)]} historyReady visible />);
    expect(live).toHaveTextContent('2 new room items');

    rerender(<ChatTimeline roomId={ROOM_TWO} records={[message(7, { room_id: ROOM_TWO, record_id: `${ROOM_TWO}:7` })]} historyReady visible />);
    expect(live).toHaveTextContent('');
  });

  it('renders every record in Archive and operational details in Events', () => {
    const records = [message(1), relay(2)];
    const { rerender } = render(<ArchiveView records={records} mode="archive" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('#1')).toBeVisible();
    expect(screen.getByText('#2')).toBeVisible();

    rerender(<ArchiveView records={records} mode="events" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('relay result')).toBeVisible();
    expect(screen.getByText('send_failed')).toBeVisible();
    expect(screen.getByText(/"recipient_identity": "cid-alice"/)).toBeVisible();
  });
});

describe('selected-room paginated history', () => {
  beforeEach(() => {
    location.hash = `#/rooms/${ROOM_ONE}`;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('loads byte-short pages through an empty EOF page, then polls after the numeric high-water mark', async () => {
    const target = room();
    const history = Array.from({ length: 401 }, (_, index) => message(index + 1));
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') {
        const after = Number(params.after);
        return history.filter((record) => record.seq > after).slice(0, Number(params.limit));
      }
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('message 401')).toBeVisible();
    expect(call.mock.calls.filter(([method]) => method === 'room.history').map(([, params]) => params)).toEqual([
      { room_id: ROOM_ONE, after: 0, limit: 200 },
      { room_id: ROOM_ONE, after: 200, limit: 200 },
      { room_id: ROOM_ONE, after: 400, limit: 200 },
      { room_id: ROOM_ONE, after: 401, limit: 200 },
    ]);

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(call.mock.calls.filter(([method]) => method === 'room.history').at(-1)?.[1]).toEqual(
      { room_id: ROOM_ONE, after: 401, limit: 200 },
    );
  });

  it('accepts an evolved briefing record reached on a later history page', async () => {
    const target = room();
    const history = Array.from({ length: 610 }, (_, index) => message(index + 1));
    history[609] = message(610, {
      category: 'briefing', briefing_version: 2, text: 'Evolved paged briefing',
    });
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') {
        const after = Number(params.after);
        return history.filter((record) => record.seq > after).slice(0, Number(params.limit));
      }
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Evolved paged briefing')).toBeVisible();
    expect(screen.queryByText(/History refresh failed/)).not.toBeInTheDocument();
    expect(call.mock.calls.filter(([method]) => method === 'room.history').map(([, params]) => params)).toEqual([
      { room_id: ROOM_ONE, after: 0, limit: 200 },
      { room_id: ROOM_ONE, after: 200, limit: 200 },
      { room_id: ROOM_ONE, after: 400, limit: 200 },
      { room_id: ROOM_ONE, after: 600, limit: 200 },
      { room_id: ROOM_ONE, after: 610, limit: 200 },
    ]);
  });

  it('loads a daemon reply record without poisoning its briefing or later history rows', async () => {
    const target = room();
    const history = [
      message(1, { category: 'briefing', text: 'Archived mission briefing' }),
      message(2, {
        text: 'Reply with durable metadata',
        source_reply_to: {
          wire_id: 'DB86B3C77C1E0C425269204C158245940AB863E26F6F965F0168116B81260F58',
          sentence: 2,
        },
      }),
      message(3, { text: 'History after the reply' }),
    ];
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') {
        const after = Number(params.after);
        return history.filter((record) => record.seq > after);
      }
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Archived mission briefing')).toBeVisible();
    expect(screen.getByText('Reply with durable metadata')).toBeVisible();
    expect(screen.getByText('History after the reply')).toBeVisible();
    expect(screen.getByText('3 records')).toBeVisible();
    expect(screen.queryByText('Briefing room-1')).not.toBeInTheDocument();
    expect(screen.queryByText(/History refresh failed/)).not.toBeInTheDocument();
    expect(call.mock.calls.filter(([method]) => method === 'room.history').map(([, params]) => params)).toEqual([
      { room_id: ROOM_ONE, after: 0, limit: 200 },
      { room_id: ROOM_ONE, after: 3, limit: 200 },
    ]);
  });

  it('keeps the room.show briefing while atomically rejecting malformed reply metadata', async () => {
    const target = room();
    const page = [
      { ...message(1), source_reply_to: { wire_id: '', extra: true } },
      message(2, { text: 'Must not render after poisoned row' }),
    ];
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') return page;
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Briefing room-1')).toBeVisible();
    expect(await screen.findByText('History refresh failed: daemon returned an invalid history page')).toBeVisible();
    expect(screen.queryByText('message 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Must not render after poisoned row')).not.toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeVisible();
  });

  it.each([
    ['gapped', [message(2)]],
    ['out-of-order', [message(2), message(1)]],
    ['duplicate', [message(1), message(1)]],
    ['non-progressing full', Array.from({ length: 200 }, () => message(1))],
  ])('rejects an initial %s page atomically without committing or advancing', async (_label, page) => {
    const target = room();
    const call = vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') return page;
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await screen.findByRole('heading', { name: 'room-1' });
    await vi.waitFor(() => expect(call.mock.calls.some(([method]) => method === 'room.history')).toBe(true));
    await act(async () => Promise.resolve());
    expect(screen.queryByText('message 1')).not.toBeInTheDocument();
    expect(screen.queryByText('message 2')).not.toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(call.mock.calls.filter(([method]) => method === 'room.history').at(-1)?.[1]).toEqual(
      { room_id: ROOM_ONE, after: 0, limit: 200 },
    );
  });

  it.each([
    ['gapped', [message(3)]],
    ['out-of-order', [message(3), message(2)]],
    ['duplicate', [message(2), message(2)]],
    ['non-progressing full', Array.from({ length: 200 }, () => message(2))],
  ])('rejects a %s subsequent page without changing the cache or high-water mark', async (_label, page) => {
    const target = room();
    let historyCalls = 0;
    const call = vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === 'room.list') return [target];
      if (method === 'room.show') return target;
      if (method === 'room.participants') return [];
      if (method === 'room.history') return ++historyCalls === 1 ? [message(1)] : page;
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    expect(await screen.findByText('message 1')).toBeVisible();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.queryByText('message 2')).not.toBeInTheDocument();
    expect(screen.queryByText('message 3')).not.toBeInTheDocument();
    expect(screen.getByText('1 records')).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(call.mock.calls.filter(([method]) => method === 'room.history').at(-1)?.[1]).toEqual(
      { room_id: ROOM_ONE, after: 1, limit: 200 },
    );
  });

  it('retains each selected room cache and resumes after its own high-water mark when switching back', async () => {
    const first = room(ROOM_ONE);
    const second = room(ROOM_TWO);
    const firstRecord = message(1, { text: 'Retained first-room history' });
    const secondRecord = message(1, { room_id: ROOM_TWO, record_id: `${ROOM_TWO}:1`, text: 'Second-room history' });
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return [first, second];
      if (method === 'room.show') return params.room_id === ROOM_ONE ? first : second;
      if (method === 'room.participants') return [];
      if (method === 'room.history') {
        if (params.room_id === ROOM_ONE) return Number(params.after) === 0 ? [firstRecord] : [];
        return Number(params.after) === 0 ? [secondRecord] : [];
      }
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    expect(await screen.findByText('Retained first-room history')).toBeVisible();
    await user.click(screen.getByText('room-2'));
    expect(await screen.findByText('Second-room history')).toBeVisible();
    await user.click(screen.getByText('room-1'));
    expect(await screen.findByText('Retained first-room history')).toBeVisible();
    expect(call.mock.calls.filter(([method, params]) => method === 'room.history' && params.room_id === ROOM_ONE).at(-1)?.[1]).toEqual(
      { room_id: ROOM_ONE, after: 1, limit: 200 },
    );
  });

  it('isolates late history responses from a previous room generation', async () => {
    const first = room(ROOM_ONE);
    const second = room(ROOM_TWO);
    const lateFirst = deferred<CommunicationRecordDto[]>();
    const secondRecord = message(1, { room_id: ROOM_TWO, record_id: `${ROOM_TWO}:1`, text: 'Current room record' });
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show') return Promise.resolve(params.room_id === ROOM_ONE ? first : second);
      if (method === 'room.participants') return Promise.resolve([]);
      if (method === 'room.history' && params.room_id === ROOM_ONE) return lateFirst.promise;
      if (method === 'room.history') return Promise.resolve([secondRecord]);
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await vi.waitFor(() => expect(call.mock.calls.some(([method, params]) => method === 'room.history' && params.room_id === ROOM_ONE)).toBe(true));

    await user.click(await screen.findByText('room-2'));
    expect(await screen.findByText('Current room record')).toBeVisible();
    lateFirst.resolve([message(1, { text: 'Stale previous-room record' })]);
    await act(async () => lateFirst.promise);

    expect(screen.getByText('Current room record')).toBeVisible();
    expect(screen.queryByText('Stale previous-room record')).not.toBeInTheDocument();
  });
});
