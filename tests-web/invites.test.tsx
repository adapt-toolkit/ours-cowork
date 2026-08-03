import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InviteManager } from '../web/src/components/InviteManager';
import type { InviteReceiptDto, RoomDto } from '../web/src/api/types';

const base: RoomDto = { version: 1, room_id: 'room-1', identity_name: 'cowork-room', identity_cid: 'cid-room', mission: { goal: 'Ship', briefing: 'Brief' }, state: 'provisioning', invites: [], seats: [], created_at: '2026-08-03T00:00:00Z' };

describe('invite management', () => {
  it('submits once and forgets a copied create secret on close', async () => {
    const user = userEvent.setup();
    const receipt: InviteReceiptDto = { room_id: 'room-1', invite: { invite_id: 'invite-new', mode: 'one_time', role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live', created_at: base.created_at }, blob: 'SECRET-INVITE-BLOB', reusable: false };
    const create = vi.fn(async () => receipt);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    render(<InviteManager room={base} connected onCreate={create} onRevoke={vi.fn()} onRecover={vi.fn()} onConfirm={vi.fn()} />);
    await user.type(screen.getByLabelText('Role'), 'builder');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('SECRET-INVITE-BLOB')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy invite' }));
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('SECRET-INVITE-BLOB')).toBeNull();
  });

  it('shows every recovery receipt and requires explicit exact-pointer confirmation', async () => {
    const user = userEvent.setup();
    const stale = (id: string, mode: 'one_time' | 'public') => ({ invite_id: id, mode, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at });
    const room = { ...base, invites: [stale('old-one', 'one_time'), stale('old-public', 'public')] };
    const receipts: InviteReceiptDto[] = room.invites.map((invite, index) => ({ room_id: room.room_id, invite: { ...invite, invite_id: `new-${index}`, state: 'receipt_pending', recovery_of: invite.invite_id, recovery_confirmed: false }, blob: `SECRET-${index}`, reusable: invite.mode === 'public', recovery_of: invite.invite_id }));
    const confirm = vi.fn(async () => receipts[0]!.invite);
    render(<InviteManager room={room} connected onCreate={vi.fn()} onRevoke={vi.fn()} onRecover={vi.fn(async () => receipts)} onConfirm={confirm} />);
    await user.click(screen.getByRole('button', { name: 'Recover missing invites' }));
    expect(await screen.findByText('SECRET-0')).toBeVisible();
    expect(screen.getByText('SECRET-1')).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Confirm old-one.*new-0/ }));
    expect(confirm).toHaveBeenCalledWith('old-one', 'new-0');
  });
});
