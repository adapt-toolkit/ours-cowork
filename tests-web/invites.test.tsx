import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InviteManager, InviteReceiptDialog, type InviteReceiptVault } from '../web/src/components/InviteManager';
import { CoworkApp, type RpcClient } from '../web/src/App';
import { validateConfirmedRecoveryInvite, validateCreatedInviteReceipt, validateRecoveryInviteReceipts, type InviteReceiptDto, type RoomDto } from '../web/src/api/types';

const base: RoomDto = { version: 1, room_id: 'room-1', identity_name: 'cowork-room', identity_cid: 'cid-room', mission: { goal: 'Ship', briefing: 'Brief' }, state: 'provisioning', invites: [], seats: [], created_at: '2026-08-03T00:00:00Z' };

describe('invite management', () => {
  it('submits once and forgets a copied create secret on close', async () => {
    const user = userEvent.setup();
    const receipt: InviteReceiptDto = { room_id: 'room-1', invite: { invite_id: 'invite-new', mode: 'one_time', role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live', created_at: base.created_at }, blob: 'SECRET-INVITE-BLOB', reusable: false };
    const create = vi.fn(async () => receipt);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
    render(<InviteHarness room={base} create={create} recover={vi.fn()} confirm={vi.fn()} />);
    await user.type(screen.getByLabelText('Role'), 'builder');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('SECRET-INVITE-BLOB')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Copy invite' }));
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('SECRET-INVITE-BLOB')).toBeNull();
  });

  it('delivers a deferred create receipt after its manager tab unmounts and clears it exactly once', async () => {
    location.hash = '#/rooms/room-1';
    const user = userEvent.setup();
    const pending = deferred<InviteReceiptDto>();
    const receipt = createdReceipt();
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([base]);
      if (method === 'room.show') return Promise.resolve(base);
      if (method === 'room.participants') return Promise.resolve([]);
      if (method === 'room.invite') return pending.promise;
      return Promise.reject(new Error(`unexpected ${method} ${JSON.stringify(params)}`));
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.type(screen.getByLabelText('Role'), 'builder');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    await user.click(screen.getByRole('tab', { name: 'Participants' }));
    pending.resolve(receipt);
    await act(async () => pending.promise);
    expect(await screen.findByText(receipt.blob)).toBeVisible();
    expect(screen.getAllByText(receipt.blob)).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Invite receipt' })).toHaveTextContent('Room room-1');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(receipt.blob)).not.toBeInTheDocument();
  });

  it('delivers deferred recovery receipts after room navigation and confirms their original room pointers', async () => {
    location.hash = '#/rooms/room-1';
    const user = userEvent.setup();
    const stale = { invite_id: 'old-one', mode: 'one_time' as const, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at };
    const first = { ...base, invites: [stale] };
    const second = { ...base, room_id: 'room-2', mission: { ...base.mission, goal: 'Other' } };
    const pending = deferred<InviteReceiptDto[]>();
    const recovered: InviteReceiptDto = { room_id: first.room_id, invite: { ...stale, invite_id: 'new-one', state: 'receipt_pending', recovery_of: stale.invite_id, recovery_confirmed: false }, blob: 'RECOVERY-SECRET', reusable: false, recovery_of: stale.invite_id };
    const call = vi.fn((method: string, params: Record<string, unknown>) => {
      if (method === 'room.list') return Promise.resolve([first, second]);
      if (method === 'room.show') return Promise.resolve(params.room_id === first.room_id ? first : second);
      if (method === 'room.participants') return Promise.resolve([]);
      if (method === 'room.recover') return pending.promise;
      if (method === 'room.recover.confirm') return Promise.resolve({ ...recovered.invite, state: 'live', recovery_confirmed: true });
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.click(screen.getByRole('button', { name: 'Recover missing invites' }));
    await user.click(screen.getByText('Other'));
    pending.resolve([recovered]);
    await act(async () => pending.promise);
    expect(await screen.findByText('RECOVERY-SECRET')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm old-one to new-one' }));
    expect(call).toHaveBeenCalledWith('room.recover.confirm', { room_id: 'room-1', recovery_of: 'old-one', invite_id: 'new-one' });
  });

  it('rejects adversarial create and recovery receipts before exposing secrets', () => {
    const createRequest = { room_id: base.room_id, mode: 'one_time' as const, role: 'builder', min_accepts: 1 };
    const validCreate = createdReceipt();
    for (const malformed of [
      { ...validCreate, room_id: 'room-other' },
      { ...validCreate, reusable: true },
      { ...validCreate, invite: { ...validCreate.invite, role: 'attacker' } },
      { ...validCreate, invite: { ...validCreate.invite, state: 'receipt_pending', recovery_of: 'old', recovery_confirmed: false } },
    ]) expect(() => validateCreatedInviteReceipt(malformed, createRequest)).toThrow(/invalid invite receipt/i);

    const source = { invite_id: 'old', mode: 'public' as const, role: 'reviewer', min_accepts: 2, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at };
    const recoveryRoom = { ...base, invites: [source] };
    const validRecovery: InviteReceiptDto = { room_id: base.room_id, invite: { ...source, invite_id: 'new', state: 'receipt_pending', recovery_of: 'old', recovery_confirmed: false }, blob: 'SAFE-SECRET', reusable: true, recovery_of: 'old' };
    for (const malformed of [
      [{ ...validRecovery, room_id: 'room-other' }],
      [{ ...validRecovery, recovery_of: 'other' }],
      [{ ...validRecovery, reusable: false }],
      [{ ...validRecovery, invite: { ...validRecovery.invite, state: 'live' } }],
      [{ ...validRecovery, invite: { ...validRecovery.invite, min_accepts: 9 } }],
      [validRecovery, { ...validRecovery }],
    ]) expect(() => validateRecoveryInviteReceipts(malformed, recoveryRoom)).toThrow(/invalid recovery receipt/i);
    expect(() => validateConfirmedRecoveryInvite({ ...validRecovery.invite, state: 'live', recovery_confirmed: true, recovery_of: 'wrong-old' }, validRecovery)).toThrow(/invalid recovery confirmation/i);
  });

  it('keeps malformed create results out of the receipt UI and reports an action-local error', async () => {
    location.hash = '#/rooms/room-1';
    const user = userEvent.setup();
    const malformed = { ...createdReceipt(), room_id: 'attacker-room', blob: 'MUST-NOT-RENDER' };
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [base];
      if (method === 'room.show') return base;
      if (method === 'room.participants') return [];
      if (method === 'room.invite') return malformed;
      throw new Error(`unexpected ${method}`);
    });
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.type(screen.getByLabelText('Role'), 'builder');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    expect((await screen.findAllByRole('alert')).some((alert) => /invalid invite receipt/i.test(alert.textContent ?? ''))).toBe(true);
    expect(screen.queryByText('MUST-NOT-RENDER')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /receipt/i })).not.toBeInTheDocument();
  });

  it('keeps a revoke modal visible and closable when context becomes a hidden responsive drawer', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    const media = dynamicMatchMedia(false);
    window.matchMedia = media.matchMedia;
    const live = { ...base, invites: [{ invite_id: 'long-live-invite-id', mode: 'public' as const, role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live' as const, created_at: base.created_at }] };
    const call = vi.fn(async (method: string) => method === 'room.list' ? [live] : method === 'room.participants' ? [] : live);
    try {
      location.hash = '#/rooms/room-1';
      render(<CoworkApp rpc={{ call } as RpcClient} />);
      await user.click(await screen.findByRole('tab', { name: 'Invite' }));
      await user.click(screen.getByRole('button', { name: 'Revoke' }));
      expect(screen.getByRole('dialog', { name: 'Revoke invite' }).closest('.modal-backdrop')?.parentElement).toBe(document.body);
      act(() => media.setMatches(true));
      expect(screen.getByLabelText('Room context', { selector: 'aside' })).toHaveAttribute('hidden');
      expect(screen.getByRole('dialog', { name: 'Revoke invite' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Revoke invite' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Context' })).toHaveFocus();
    } finally { window.matchMedia = original; }
  });

  it('shows every recovery receipt and requires explicit exact-pointer confirmation', async () => {
    const user = userEvent.setup();
    const stale = (id: string, mode: 'one_time' | 'public') => ({ invite_id: id, mode, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at });
    const room = { ...base, invites: [stale('old-one', 'one_time'), stale('old-public', 'public')] };
    const receipts: InviteReceiptDto[] = room.invites.map((invite, index) => ({ room_id: room.room_id, invite: { ...invite, invite_id: `new-${index}`, state: 'receipt_pending', recovery_of: invite.invite_id, recovery_confirmed: false }, blob: `SECRET-${index}`, reusable: invite.mode === 'public', recovery_of: invite.invite_id }));
    const confirm = vi.fn(async () => receipts[0]!.invite);
    render(<InviteHarness room={room} create={vi.fn()} recover={vi.fn(async () => receipts)} confirm={confirm} />);
    await user.click(screen.getByRole('button', { name: 'Recover missing invites' }));
    expect(await screen.findByText('SECRET-0')).toBeVisible();
    expect(screen.getByText('SECRET-1')).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Confirm old-one.*new-0/ }));
    expect(confirm).toHaveBeenCalledWith('old-one', 'new-0');
  });
});

function createdReceipt(): InviteReceiptDto { return { room_id: base.room_id, invite: { invite_id: 'invite-new', mode: 'one_time', role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live', created_at: base.created_at }, blob: 'SECRET-INVITE-BLOB', reusable: false }; }
function InviteHarness({ room, create, recover, confirm }: { room: RoomDto; create(input: unknown): Promise<InviteReceiptDto>; recover(): Promise<InviteReceiptDto[]>; confirm(oldId: string, newId: string): Promise<unknown> }) {
  const [vault, setVault] = React.useState<InviteReceiptVault>();
  return <><InviteManager room={room} connected onCreate={async (input) => { const receipt = await create(input); setVault({ room_id: room.room_id, receipts: [receipt] }); }} onRevoke={vi.fn()} onRecover={async () => { const receipts = await recover(); if (receipts.length) setVault({ room_id: room.room_id, receipts }); }} />{vault && <InviteReceiptDialog vault={vault} onClose={() => setVault(undefined)} onConfirm={async (receipt) => { await confirm(receipt.recovery_of!, receipt.invite.invite_id); }} />}</>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function dynamicMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const object = { get matches() { return matches; }, media: '(max-width: 999px)', onchange: null, addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener), removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true) } as MediaQueryList;
  return { matchMedia: vi.fn(() => object), setMatches(value: boolean) { matches = value; listeners.forEach((listener) => listener({ matches: value, media: object.media } as MediaQueryListEvent)); } };
}
