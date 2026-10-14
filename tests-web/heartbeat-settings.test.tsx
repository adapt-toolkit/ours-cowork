import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkApp, type RpcClient } from '../web/src/App';
import { isRoomDto, type HeartbeatPolicyDto, type RoomDto } from '../web/src/api/types';

const AT = '2026-10-14T12:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';

function room(heartbeat?: Partial<HeartbeatPolicyDto>): RoomDto {
  return {
    version: 2,
    room_id: ROOM_ID,
    room_name: 'Heartbeat room',
    identity_name: 'ours-cowork:Heartbeat room',
    identity_cid: 'D'.repeat(64),
    mission: { goal: 'Ship', briefing: 'Brief.', briefing_version: 1 },
    role_briefings: {},
    rest_roles: [],
    command_grants: [],
    role_command_grants: [],
    anonymous: false,
    quiet_membership: false,
    membership_epoch: 0,
    state: 'active',
    status: 'in_progress',
    ...(heartbeat === undefined ? {} : { heartbeat: {
      enabled: false, interval_minutes: 20, generation: 1, updated_at: AT, anchor_at: AT, observed_seq: 0, ...heartbeat,
    } }),
    invites: [],
    seats: [],
    created_at: AT,
    activated_at: AT,
  };
}

describe('room heartbeat settings', () => {
  beforeEach(() => { location.hash = ''; });

  it('validates the DTO policy shape', () => {
    expect(isRoomDto(room({}))).toBe(true);
    expect(isRoomDto(room())).toBe(true);
    expect(isRoomDto(room({ interval_minutes: 0 }))).toBe(false);
    expect(isRoomDto(room({ interval_minutes: 1441 }))).toBe(false);
    expect(isRoomDto({ ...room({}), heartbeat: { ...room({}).heartbeat, extra: true } })).toBe(false);
  });

  it('creates a room with heartbeats enabled entirely from the keyboard', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [];
      if (method === 'room.create') return { ...room({ enabled: true, interval_minutes: 45 }), state: 'provisioning', activated_at: undefined, status: undefined };
      if (method === 'room.show') return room({ enabled: true, interval_minutes: 45 });
      return [];
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Heartbeat room');
    await user.type(within(dialog).getByLabelText('Goal'), 'Ship');
    await user.type(within(dialog).getByLabelText('Briefing'), 'Brief.');
    // Collapsed by default: the heartbeat controls are not in the tab order yet.
    const summary = within(dialog).getByText('Advanced settings');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.tab();
    expect(summary).toHaveFocus();
    // jsdom lacks native summary keyboard activation; real Chrome checks Enter in test:browser.
    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    await user.tab();
    const enabled = within(dialog).getByLabelText('Send inactivity heartbeats');
    expect(enabled).toHaveFocus();
    expect(enabled).not.toBeChecked();
    await user.keyboard(' ');
    expect(enabled).toBeChecked();
    await user.tab();
    const interval = within(dialog).getByLabelText('Heartbeat interval (minutes)');
    expect(interval).toHaveFocus();
    expect(interval).toHaveValue(20);
    await user.clear(interval);
    await user.type(interval, '0');
    expect(within(dialog).getByText('Use 1–1440 minutes.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Create mission room' })).toBeDisabled();
    await user.clear(interval);
    await user.type(interval, '45');
    await user.keyboard('{Enter}');

    expect(call).toHaveBeenCalledWith('room.create', expect.objectContaining({
      goal: 'Ship', briefing: 'Brief.', heartbeat: { enabled: true, interval_minutes: 45 },
    }));
  });

  it('omits the policy when advanced settings keep the daemon defaults', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [];
      if (method === 'room.create') return { ...room({}), state: 'provisioning', activated_at: undefined, status: undefined };
      return room({});
    });
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Create room' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Heartbeat room');
    await user.type(within(dialog).getByLabelText('Goal'), 'Ship');
    await user.type(within(dialog).getByLabelText('Briefing'), 'Brief.');
    await user.click(within(dialog).getByRole('button', { name: 'Create mission room' }));
    const create = call.mock.calls.find(([method]) => method === 'room.create') as unknown as [string, Record<string, unknown>];
    expect(create[1]).not.toHaveProperty('heartbeat');
  });

  it('shows the persisted policy of an existing room and saves only the heartbeat change', async () => {
    let current = room({ enabled: false, interval_minutes: 20 });
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      if (method === 'room.heartbeat.set') {
        current = room({ enabled: params?.enabled as boolean ?? false, interval_minutes: (params?.interval_minutes as number) ?? 20, generation: 2 });
        return current;
      }
      if (method === 'room.participants' || method === 'room.history') return [];
      throw new Error(`unexpected ${method}`);
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);

    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('Advanced settings'));
    expect(within(dialog).getByLabelText('Send inactivity heartbeats')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Heartbeat interval (minutes)')).toHaveValue(20);
    expect(within(dialog).getByRole('button', { name: 'Save settings' })).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Send inactivity heartbeats'));
    await user.clear(within(dialog).getByLabelText('Heartbeat interval (minutes)'));
    await user.type(within(dialog).getByLabelText('Heartbeat interval (minutes)'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));

    expect(call).toHaveBeenCalledWith('room.heartbeat.set', { room_id: ROOM_ID, enabled: true, interval_minutes: 30 });
    expect(call.mock.calls.filter(([method]) => method === 'room.settings')).toHaveLength(0);

    // Reopening reads the persisted DTO, not the closed draft.
    await screen.findByRole('button', { name: 'Room settings' });
    await vi.waitFor(() => expect(call.mock.calls.filter(([method]) => method === 'room.show').length).toBeGreaterThan(1));
    await user.click(screen.getByRole('button', { name: 'Room settings' }));
    const reopened = screen.getByRole('dialog');
    await user.click(within(reopened).getByText('Advanced settings'));
    expect(within(reopened).getByLabelText('Send inactivity heartbeats')).toBeChecked();
    expect(within(reopened).getByLabelText('Heartbeat interval (minutes)')).toHaveValue(30);
  });

  it('presents a room without a stored policy as disabled at the 20-minute default', async () => {
    const current = room();
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      return [];
    });
    const user = userEvent.setup();
    location.hash = `#/rooms/${ROOM_ID}`;
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('button', { name: 'Room settings' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByText('Advanced settings'));
    expect(within(dialog).getByLabelText('Send inactivity heartbeats')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Heartbeat interval (minutes)')).toHaveValue(20);
  });
});
