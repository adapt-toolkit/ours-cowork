import { type FormEvent, useRef, useState } from 'react';

import { RpcError } from '../api/rpc';
import type { InviteMode, InviteReceiptDto, RoomDto, RoomInviteDto } from '../api/types';
import { roomCapabilities } from '../state/roomModel';
import { Modal } from './RoomDialogs';

export interface InviteReceiptVault {
  room_id: string;
  receipts: InviteReceiptDto[];
}

export function InviteManager({ room, connected, onCreate, onRevoke, onRecover }: {
  room: RoomDto; connected: boolean;
  onCreate(input: { mode: InviteMode; role: string; min_accepts: number }): Promise<void>;
  onRevoke(inviteId: string): Promise<unknown>;
  onRecover(): Promise<void>;
}) {
  const [role, setRole] = useState('');
  const [mode, setMode] = useState<InviteMode>('one_time');
  const [minimum, setMinimum] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revoke, setRevoke] = useState<RoomInviteDto>();
  const inFlight = useRef(false);
  const caps = roomCapabilities(room.state, connected);
  const parsedMinimum = Number(minimum);
  const roleBytes = new TextEncoder().encode(role.trim()).byteLength;
  const roleError = roleBytes < 1 ? 'Role is required.' : roleBytes > 256 ? 'Role must be at most 256 UTF-8 bytes.' : undefined;
  const minimumError = mode === 'public' && (!Number.isSafeInteger(parsedMinimum) || parsedMinimum < 1) ? 'Minimum acceptances must be a positive whole number.' : undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    if (roleError || minimumError || inFlight.current) return;
    await mutate(async () => {
      await onCreate({ mode, role: role.trim(), min_accepts: mode === 'one_time' ? 1 : parsedMinimum });
      setRole('');
    }, 'Invite creation');
  }

  async function mutate(action: () => Promise<void>, label: string) {
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await action(); }
    catch (failure) {
      setError(actionError(failure, label));
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <>
    <form className="invite-form" onSubmit={create}>
      <div className="field"><label htmlFor="invite-role">Role</label><input id="invite-role" value={role} onChange={(event) => setRole(event.target.value)} aria-invalid={Boolean(roleError)} />{roleError && <small className="field-error">{roleError}</small>}</div>
      <div className="field"><label htmlFor="invite-mode">Mode</label><select id="invite-mode" value={mode} onChange={(event) => setMode(event.target.value as InviteMode)}><option value="one_time">One-time</option><option value="public">Public</option></select></div>
      {mode === 'public' && <div className="field"><label htmlFor="invite-minimum">Minimum acceptances</label><input id="invite-minimum" inputMode="numeric" value={minimum} onChange={(event) => setMinimum(event.target.value)} aria-invalid={Boolean(minimumError)} />{minimumError && <small className="field-error">{minimumError}</small>}</div>}
      <button className="primary-button" type="submit" disabled={!caps.canCreateInvite || busy || Boolean(roleError || minimumError)}>Create invite</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="invite-list">{room.invites.map((invite) => <article className="invite-card" key={invite.invite_id}><header><strong>{invite.role}</strong><span className={`state-text state-text--${invite.state}`}>{labelState(invite.state)}</span></header><p>{invite.mode === 'public' ? 'Public' : 'One-time'} · {invite.accepted_cids.length} of {invite.min_accepts} accepted</p><code>{invite.invite_id}</code>{invite.recovery_of && <p>Recovery lineage: <code>{invite.recovery_of}</code> → <code>{invite.invite_id}</code> ({invite.recovery_confirmed ? 'confirmed' : 'awaiting confirmation'})</p>}<button className="quiet-button" type="button" disabled={!caps.canRevokeInvite || busy || !canRevoke(invite)} onClick={() => setRevoke(invite)}>Revoke</button></article>)}</div>
    {room.invites.some((invite) => invite.state === 'replacement_required') && <div className="recovery-callout"><p>The original invite secret is lost and cannot be recovered. Mint replacements, save every returned secret, then confirm each exact old/new pair. Repeating recovery rotates any unconfirmed replacement.</p><button className="secondary-button" type="button" disabled={!caps.canRecoverInvite || busy} onClick={() => mutate(onRecover, 'Invite recovery')}>Recover missing invites</button></div>}
    {revoke && <Modal title="Revoke invite" open onClose={() => setRevoke(undefined)} locked={busy}><div className="dialog-form"><p>Revoke the <strong>{revoke.role}</strong> invite <code>{shortId(revoke.invite_id)}</code>? It can no longer admit participants.</p><div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setRevoke(undefined)} disabled={busy}>Cancel</button><button className="danger-button" type="button" disabled={busy} onClick={() => mutate(async () => { await onRevoke(revoke.invite_id); setRevoke(undefined); }, 'Invite revocation')}>Revoke invite</button></div></div></Modal>}
  </>;
}

export function InviteReceiptDialog({ vault, onClose, onConfirm }: {
  vault: InviteReceiptVault;
  onClose(): void;
  onConfirm(receipt: InviteReceiptDto): Promise<void>;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  async function confirm(receipt: InviteReceiptDto) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await onConfirm(receipt); }
    catch (failure) { setError(actionError(failure, 'Recovery confirmation')); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Modal title={vault.receipts.some((receipt) => receipt.recovery_of) ? 'Recovered invite receipts' : 'Invite receipt'} open onClose={onClose} locked={busy}><div className="dialog-form"><p className="dialog-intro">Room <code>{vault.room_id}</code>. Copy and save {vault.receipts.length === 1 ? 'this secret' : 'every secret'} now. It is not stored by cowork and disappears when this dialog closes.</p>{vault.receipts.map((receipt) => <section className="receipt" key={`${receipt.recovery_of ?? 'new'}:${receipt.invite.invite_id}`}><p><strong>{receipt.invite.role}</strong> · {receipt.invite.mode === 'public' ? 'Public' : 'One-time'}</p>{receipt.recovery_of && <p>Old <code>{receipt.recovery_of}</code><br />New <code>{receipt.invite.invite_id}</code></p>}<pre>{receipt.blob}</pre><button className="secondary-button" type="button" onClick={async () => { try { await navigator.clipboard.writeText(receipt.blob); setCopyStatus(`Copied ${shortId(receipt.invite.invite_id)}`); } catch { setCopyStatus('Copy failed. Select and copy the secret manually.'); } }}>Copy invite</button>{receipt.recovery_of && <button className="primary-button" type="button" disabled={busy} aria-label={`Confirm ${receipt.recovery_of} to ${receipt.invite.invite_id}`} onClick={() => confirm(receipt)}>Confirm old/new pair</button>}</section>)}{error && <p className="form-error" role="alert">{error}</p>}<p role="status" aria-live="polite">{copyStatus}</p><div className="dialog-actions"><button className="primary-button" type="button" disabled={busy} onClick={onClose}>Done</button></div></div></Modal>;
}

function actionError(failure: unknown, label: string): string {
  return failure instanceof RpcError && failure.outcomeUnknown
    ? `${label} has an unknown outcome. The current state is preserved; check refreshed durable state before deciding whether to act again. ${failure.message}`
    : failure instanceof Error ? failure.message : `${label} failed.`;
}
function canRevoke(invite: RoomInviteDto) { return invite.state === 'live' || invite.state === 'replacement_required' || invite.state === 'receipt_pending'; }
function shortId(id: string) { return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`; }
function labelState(state: RoomInviteDto['state']) { return state.replaceAll('_', ' '); }
