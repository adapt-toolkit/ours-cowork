import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import type { MessageRecordDto, RoomDto } from '../web/src/api/types';

const AT = '2026-08-19T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const OTHER_ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x72';
const MESSAGE_ID = '01jz6y7n8p9q0r1s2t3v4w5x71';
const SEND_AS = 'Send as';

function room(overrides: Partial<RoomDto> = {}): RoomDto {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Multi-identity chat test',
    identity_name: 'cowork-room-test-1',
    identity_cid: 'cid-room',
    mission: { goal: 'Test multi-identity chat', briefing: 'Send as registered roles', briefing_version: 1 },
    role_briefings: {},
    rest_roles: ['Reviewer', 'Scribe'],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    state: 'active',
    invites: [],
    seats: [],
    created_at: AT,
    ...overrides,
  };
}

function roleMessage(role: string, text: string, overrides: Partial<MessageRecordDto> = {}): MessageRecordDto {
  return {
    version: 1,
    room_id: ROOM_ID,
    seq: 1,
    record_id: `${ROOM_ID}:1`,
    at: AT,
    kind: 'message',
    message_id: MESSAGE_ID,
    // The daemon signs as the room and carries the role as label and display name.
    author: { identity: 'cid-room', display_name: role, role },
    category: 'chat',
    text,
    recipient_identities: [],
    ...overrides,
  };
}

/**
 * Drive the app against a scripted daemon. `rooms()` is read on every poll so a
 * test can unregister a role mid-flight the way the CLI would.
 */
function harness(options: {
  rooms(): RoomDto[];
  say?: (params: Record<string, unknown>) => Promise<unknown>;
  message?: (params: Record<string, unknown>) => Promise<unknown>;
  history?: () => unknown[];
}) {
  const call = vi.fn((method: string, params: Record<string, unknown>) => {
    if (method === 'room.list') return Promise.resolve(options.rooms());
    if (method === 'room.show') {
      const found = options.rooms().find((candidate) => candidate.room_id === params.room_id);
      return found ? Promise.resolve(found) : Promise.reject(new Error('missing room'));
    }
    if (method === 'room.participants') return Promise.resolve([]);
    if (method === 'room.history') return Promise.resolve(options.history?.() ?? []);
    if (method === 'room.say') return options.say?.(params) ?? Promise.reject(new Error('unexpected room.say'));
    if (method === 'room.message') return options.message?.(params) ?? Promise.reject(new Error('unexpected room.message'));
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  return { call, rpc: { call } as RpcClient };
}

function callsTo(call: ReturnType<typeof vi.fn>, method: string): Record<string, unknown>[] {
  return call.mock.calls.filter(([name]) => name === method).map(([, params]) => params as Record<string, unknown>);
}

describe('send a room message as a registered REST role', () => {
  it('offers no author picker when the room has registered no REST roles', async () => {
    const { rpc } = harness({ rooms: () => [room({ rest_roles: [] })] });
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={rpc} />);

    await screen.findByLabelText('Message the room');
    expect(screen.queryByLabelText(SEND_AS)).not.toBeInTheDocument();
  });

  it('lists only the room’s registered roles, defaults to the room’s own voice, and marks itself a testing affordance', async () => {
    const { rpc } = harness({ rooms: () => [room()] });
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={rpc} />);

    const picker = await screen.findByLabelText(SEND_AS);
    expect([...picker.querySelectorAll('option')].map((option) => option.textContent))
      .toEqual(['The room itself', 'Reviewer', 'Scribe']);
    expect(picker).toHaveValue('');
    expect(screen.getByText(/Testing affordance\./)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });

  it('sends the selected role over room.say, never room.message, and shows the active role in the UI', async () => {
    const text = 'Reviewed the release diff';
    const confirmed = roleMessage('Reviewer', text);
    let sent = false;
    const { call, rpc } = harness({
      rooms: () => [room()],
      history: () => sent ? [confirmed] : [],
      say: (params) => { sent = true; return Promise.resolve(confirmed); },
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    await user.selectOptions(await screen.findByLabelText(SEND_AS), 'Reviewer');
    expect(screen.getByPlaceholderText(/labelled “Reviewer”/)).toBeVisible();
    const input = screen.getByLabelText('Message the room');
    await user.type(input, text);
    await user.click(screen.getByRole('button', { name: 'Send as Reviewer' }));

    expect(callsTo(call, 'room.say')).toEqual([{ room_id: ROOM_ID, role: 'Reviewer', text }]);
    expect(callsTo(call, 'room.message')).toEqual([]);
    expect(await screen.findByText(text, { selector: '.chat-row__text' })).toBeVisible();
    expect(input).toHaveValue('');
    // The selection survives the send so a tester can post repeatedly as one role.
    expect(screen.getByLabelText(SEND_AS)).toHaveValue('Reviewer');
  });

  it('returns to the room’s own voice on room.message when the picker is reset', async () => {
    const text = 'Back to the room voice';
    const confirmed = roleMessage('room', text, {
      author: { identity: 'cid-room', display_name: 'cowork-room-test-1', role: 'room' },
    });
    const { call, rpc } = harness({
      rooms: () => [room()],
      message: () => Promise.resolve(confirmed),
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    const picker = await screen.findByLabelText(SEND_AS);
    await user.selectOptions(picker, 'Scribe');
    await user.selectOptions(picker, '');
    await user.type(screen.getByLabelText('Message the room'), text);
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(callsTo(call, 'room.message')).toEqual([{ room_id: ROOM_ID, text }]);
    expect(callsTo(call, 'room.say')).toEqual([]);
  });

  it('keeps each room’s selected role with its own room across navigation', async () => {
    const other = room({ room_id: OTHER_ROOM_ID, room_name: 'Second room', identity_cid: 'cid-other', rest_roles: ['Auditor'] });
    const { rpc } = harness({ rooms: () => [room(), other] });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    await user.selectOptions(await screen.findByLabelText(SEND_AS), 'Reviewer');
    await user.click(screen.getByText('Second room'));
    const otherPicker = await screen.findByLabelText(SEND_AS);
    expect([...otherPicker.querySelectorAll('option')].map((option) => option.textContent))
      .toEqual(['The room itself', 'Auditor']);
    expect(otherPicker).toHaveValue('');

    await user.click(screen.getByText('Multi-identity chat test'));
    expect(await screen.findByLabelText(SEND_AS)).toHaveValue('Reviewer');
  });

  it('refuses the send and issues no RPC once the selected role is unregistered under it', async () => {
    let roles = ['Reviewer', 'Scribe'];
    const { call, rpc } = harness({ rooms: () => [room({ rest_roles: roles })] });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    await user.selectOptions(await screen.findByLabelText(SEND_AS), 'Reviewer');
    const input = screen.getByLabelText('Message the room');
    await user.type(input, 'Posted after revocation');

    roles = ['Scribe'];
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await vi.waitFor(() => expect(screen.getByLabelText(SEND_AS)).toHaveValue('Reviewer'));
    await vi.waitFor(() => expect(screen.getByText(/no longer registered for REST authorship/)).toBeVisible());
    expect(screen.getByRole('button', { name: 'Send as Reviewer' })).toBeDisabled();

    await act(async () => { screen.getByLabelText('Message the room').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(callsTo(call, 'room.say')).toEqual([]);
    expect(callsTo(call, 'room.message')).toEqual([]);
    expect(screen.getByLabelText('Message the room')).toHaveValue('Posted after revocation');
  });

  it.each([
    ['a foreign signing identity', (record: MessageRecordDto) => ({ ...record, author: { ...record.author, identity: 'cid-someone-else' } })],
    ['a different role than requested', (record: MessageRecordDto) => ({ ...record, author: { ...record.author, role: 'Scribe', display_name: 'Scribe' } })],
    ['the room display name instead of the role', (record: MessageRecordDto) => ({ ...record, author: { ...record.author, display_name: 'cowork-room-test-1' } })],
  ])('retains the draft when the role confirmation claims %s', async (_label, corrupt) => {
    const text = 'Must not be treated as sent';
    const { call, rpc } = harness({
      rooms: () => [room()],
      say: () => Promise.resolve(corrupt(roleMessage('Reviewer', text))),
    });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    await user.selectOptions(await screen.findByLabelText(SEND_AS), 'Reviewer');
    const input = screen.getByLabelText('Message the room');
    await user.type(input, text);
    await user.click(screen.getByRole('button', { name: 'Send as Reviewer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid message confirmation/i);
    expect(input).toHaveValue(text);
    expect(callsTo(call, 'room.say')).toHaveLength(1);
  });

  it('disables the picker while a send is pending and while the room is not active', async () => {
    let current = room();
    const never = new Promise<never>(() => {});
    const { rpc } = harness({ rooms: () => [current], say: () => never });
    location.hash = `#/rooms/${ROOM_ID}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={rpc} />);

    await user.selectOptions(await screen.findByLabelText(SEND_AS), 'Scribe');
    await user.type(screen.getByLabelText('Message the room'), 'Pending forever');
    await user.click(screen.getByRole('button', { name: 'Send as Scribe' }));
    expect(screen.getByLabelText(SEND_AS)).toBeDisabled();

    current = room({ state: 'closing' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await vi.waitFor(() => expect(screen.getByLabelText(SEND_AS)).toBeDisabled());
  });
});
