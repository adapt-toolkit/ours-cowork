import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RoomContext } from '../web/src/components/RoomContext';
import type { ParticipantDto, RoomDto } from '../web/src/api/types';

const room: RoomDto = { version: 1, room_id: '01jz6y7n8p9q0r1s2t3v4w5x70', room_name: 'Safe ship', identity_name: 'cowork-room', identity_cid: 'cid-room', mission: { goal: 'Ship safely', briefing: 'Brief' }, state: 'active', invites: [{ invite_id: 'invite-1', mode: 'public', role: 'builder', min_accepts: 2, accepted_cids: ['cid-a'], state: 'live', created_at: '2026-08-03T00:00:00Z' }], seats: [], created_at: '2026-08-03T00:00:00Z' };
const participants: ParticipantDto[] = [{ identity: 'cid-a', display_name: 'Alice', role: 'builder', invite_id: 'invite-1', accepted_at: '2026-08-03T00:00:00Z' }];

describe('room participants context', () => {
  it('shows textual lifecycle, exact seats, monospace IDs, and durable acceptance totals', () => {
    render(<RoomContext room={room} participants={participants} connected tab="participants" open drawer={false} onTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Active')).toBeVisible();
    expect(screen.getByText('Alice')).toBeVisible();
    expect(screen.getByText('cid-a')).toHaveClass('mono');
    expect(screen.getByText(/1 of 2 accepted/)).toBeVisible();
    expect(screen.getByText('1 seat')).toBeVisible();
  });
});
