import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { InviteManager, InviteReceiptDialog, type InviteReceiptVault } from '../web/src/components/InviteManager';
import { CoworkApp, type RpcClient } from '../web/src/App';
import { validateConfirmedRecoveryInvite, validateCreatedInviteReceipt, validateRecoveryInviteReceipts, type InviteReceiptDto, type RoomDto } from '../web/src/api/types';

const ROOM_ONE = '01jz6y7n8p9q0r1s2t3v4w5x70';
const ROOM_TWO = '01jz6y7n8p9q0r1s2t3v4w5x71';
const base: RoomDto = { version: 1, room_id: ROOM_ONE, room_name: 'Ship room', identity_name: 'cowork-room', identity_cid: 'cid-room', mission: { goal: 'Ship', briefing: 'Brief' }, state: 'provisioning', invites: [], seats: [], created_at: '2026-08-03T00:00:00Z' };

describe('invite management', () => {
  it('submits once and forgets a copied create secret on close', async () => {
    const user = userEvent.setup();
    const receipt: InviteReceiptDto = { room_id: ROOM_ONE, invite: { invite_id: 'invite-new', mode: 'one_time', role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live', created_at: base.created_at }, blob: 'SECRET-INVITE-BLOB', reusable: false };
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
    location.hash = `#/rooms/${ROOM_ONE}`;
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
    expect(screen.getByRole('dialog', { name: 'Invite receipt' })).toHaveTextContent(`Room ${ROOM_ONE}`);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(receipt.blob)).not.toBeInTheDocument();
  });

  it('delivers deferred recovery receipts after room navigation and confirms their original room pointers', async () => {
    location.hash = `#/rooms/${ROOM_ONE}`;
    const user = userEvent.setup();
    const stale = { invite_id: 'old-one', mode: 'one_time' as const, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at };
    const first = { ...base, invites: [stale] };
    const second = { ...base, room_id: ROOM_TWO, room_name: 'Other room', mission: { ...base.mission, goal: 'Other' } };
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
    await user.click(screen.getByText('Other room'));
    pending.resolve([recovered]);
    await act(async () => pending.promise);
    expect(await screen.findByText('RECOVERY-SECRET')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm old-one to new-one' }));
    expect(call).toHaveBeenCalledWith('room.recover.confirm', { room_id: ROOM_ONE, recovery_of: 'old-one', invite_id: 'new-one' });
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

  it('accepts every exact idempotent confirmation replay state and nonzero accepted CIDs', () => {
    const pending: InviteReceiptDto = { room_id: base.room_id, invite: { invite_id: 'new-replay', mode: 'public', role: 'reviewer', min_accepts: 2, accepted_cids: [], state: 'receipt_pending', recovery_of: 'old-replay', recovery_confirmed: false, created_at: base.created_at }, blob: 'REPLAY-SECRET', reusable: true, recovery_of: 'old-replay' };
    for (const state of ['live', 'consumed', 'replacement_required', 'revoked'] as const) {
      const confirmed = { ...pending.invite, state, recovery_confirmed: true, accepted_cids: ['cid-alice'] };
      expect(validateConfirmedRecoveryInvite(confirmed, pending)).toEqual(confirmed);
    }
    for (const rejected of [
      { ...pending.invite },
      { ...pending.invite, state: 'live', recovery_confirmed: false },
      { ...pending.invite, state: 'live', recovery_confirmed: true, recovery_of: 'wrong' },
      { ...pending.invite, state: 'live', recovery_confirmed: true, invite_id: 'wrong' },
      { ...pending.invite, state: 'live', recovery_confirmed: true, role: 'wrong' },
    ]) expect(() => validateConfirmedRecoveryInvite(rejected, pending)).toThrow(/invalid recovery confirmation/i);
  });

  it('keeps malformed create results out of the receipt UI and reports an action-local error', async () => {
    location.hash = `#/rooms/${ROOM_ONE}`;
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

  it.each(['disconnect', 'lifecycle'] as const)('retains invite fields and sends no create/recovery RPC after a %s capability change', async (change) => {
    const source = { invite_id: 'old-capability', mode: 'one_time' as const, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at };
    let current: RoomDto = { ...base, invites: [source] };
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.invite' || method === 'room.recover') throw new Error('mutation must not dispatch');
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ONE}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.type(screen.getByLabelText('Role'), 'retained builder');

    if (change === 'disconnect') disconnected = true;
    else current = { ...current, state: 'closing' };
    fireEvent(document, new Event('visibilitychange'));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Create invite' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Recover missing invites' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Role').closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Recover missing invites' }));
    expect(call.mock.calls.filter(([method]) => method === 'room.invite' || method === 'room.recover')).toHaveLength(0);
    expect(screen.getByLabelText('Role')).toHaveValue('retained builder');
  });

  it('retains an open revoke confirmation and sends no RPC after lifecycle change', async () => {
    const liveInvite = { invite_id: 'live-capability', mode: 'public' as const, role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live' as const, created_at: base.created_at };
    let current: RoomDto = { ...base, invites: [liveInvite] };
    const call = vi.fn(async (method: string) => {
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.revoke') throw new Error('mutation must not dispatch');
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ONE}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    current = { ...current, state: 'closing' };
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText(/Revocation is unavailable because the connection or room lifecycle changed/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Revoke invite' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invite' }));
    expect(call.mock.calls.filter(([method]) => method === 'room.revoke')).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Revoke invite' })).toBeVisible();
  });

  it.each(['disconnect', 'lifecycle', 'lineage'] as const)('retains a recovery receipt and sends no confirmation after a %s change', async (change) => {
    const source = { invite_id: 'old-confirm', mode: 'one_time' as const, role: 'reviewer', min_accepts: 1, accepted_cids: [], state: 'replacement_required' as const, created_at: base.created_at };
    let current: RoomDto = { ...base, invites: [source] };
    const receipt: InviteReceiptDto = {
      room_id: ROOM_ONE,
      invite: { ...source, invite_id: 'new-confirm', state: 'receipt_pending', recovery_of: source.invite_id, recovery_confirmed: false },
      blob: 'CAPABILITY-RECOVERY-SECRET', reusable: false, recovery_of: source.invite_id,
    };
    let disconnected = false;
    const call = vi.fn(async (method: string) => {
      if (disconnected && (method === 'room.list' || method === 'room.show')) throw new Error('offline');
      if (method === 'room.list') return [current];
      if (method === 'room.show') return current;
      if (method === 'room.participants' || method === 'room.history') return [];
      if (method === 'room.recover') return [receipt];
      if (method === 'room.recover.confirm') throw new Error('mutation must not dispatch');
      throw new Error(`unexpected ${method}`);
    });
    location.hash = `#/rooms/${ROOM_ONE}`;
    const user = userEvent.setup();
    render(<CoworkApp rpc={{ call } as RpcClient} />);
    await user.click(await screen.findByRole('tab', { name: 'Invite' }));
    await user.click(screen.getByRole('button', { name: 'Recover missing invites' }));
    expect(await screen.findByText(receipt.blob)).toBeVisible();

    if (change === 'disconnect') disconnected = true;
    else if (change === 'lifecycle') current = { ...current, state: 'closing' };
    else current = { ...current, invites: [{ ...source, state: 'revoked' }] };
    fireEvent(document, new Event('visibilitychange'));
    const confirm = screen.getByRole('button', { name: /Confirm old-confirm.*new-confirm/ });
    await vi.waitFor(() => expect(confirm).toBeDisabled());
    expect(screen.getByText(receipt.blob)).toBeVisible();
    fireEvent.click(confirm);
    expect(call.mock.calls.filter(([method]) => method === 'room.recover.confirm')).toHaveLength(0);
  });

  it('keeps a revoke modal visible and closable when context becomes a hidden responsive drawer', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    const media = dynamicMatchMedia(false);
    window.matchMedia = media.matchMedia;
    const live = { ...base, invites: [{ invite_id: 'long-live-invite-id', mode: 'public' as const, role: 'builder', min_accepts: 1, accepted_cids: [], state: 'live' as const, created_at: base.created_at }] };
    const call = vi.fn(async (method: string) => method === 'room.list' ? [live] : method === 'room.participants' ? [] : live);
    try {
      location.hash = `#/rooms/${ROOM_ONE}`;
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
    expect(screen.getByText('SECRET-0')).toBeVisible();
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
