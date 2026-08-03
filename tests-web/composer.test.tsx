import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RpcError } from '../web/src/api/rpc';
import { CoworkApp, type RpcClient } from '../web/src/App';
import type { MessageRecordDto, RoomDto } from '../web/src/api/types';
import { RoomComposer } from '../web/src/components/RoomComposer';

const AT = '2026-08-03T00:00:00.000Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('authoritative room composer', () => {
  it('is active-only and disconnected-safe', () => {
    const { rerender } = render(<RoomComposer roomState="provisioning" connected onSend={vi.fn()} />);
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    rerender(<RoomComposer roomState="active" connected={false} onSend={vi.fn()} />);
    expect(screen.getByLabelText('Message the room')).toBeDisabled();
  });

  it('uses Enter to issue exactly one request, disables pending input, and clears only after confirmation', async () => {
    const pending = deferred<void>();
    const onSend = vi.fn(() => pending.promise);
    const user = userEvent.setup();
    render(<RoomComposer roomState="active" connected onSend={onSend} />);
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
    render(<RoomComposer roomState="active" connected onSend={onSend} />);
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
      version: 1, room_id: 'room-1', identity_name: 'cowork-room-room-1', identity_cid: 'cid-room',
      mission: { goal: 'Release coordination', briefing: 'Coordinate carefully' }, state: 'active',
      invites: [], seats: [], created_at: AT,
    };
    const confirmed: MessageRecordDto = {
      version: 1, room_id: 'room-1', seq: 1, record_id: 'room-1:1', at: AT,
      kind: 'message', message_id: 'message-1', author: { identity: 'cid-room', display_name: 'cowork-room-room-1', role: 'room' },
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
    location.hash = '#/rooms/room-1';
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    const input = await screen.findByLabelText('Message the room');
    await user.type(input, confirmed.text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(call.mock.calls.filter(([method]) => method === 'room.message')).toEqual([
      ['room.message', { room_id: 'room-1', text: confirmed.text }],
    ]);
    expect(screen.queryByText(confirmed.text, { selector: '.chat-row__text' })).not.toBeInTheDocument();
    pending.resolve(confirmed);
    expect(await screen.findByText(confirmed.text, { selector: '.chat-row__text' })).toBeVisible();
    expect(input).toHaveValue('');
    expect(call.mock.calls.filter(([method]) => method === 'room.history').length).toBeGreaterThanOrEqual(2);
  });
});
