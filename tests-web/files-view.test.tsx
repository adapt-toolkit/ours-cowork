import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FileRecordDto, RoomDto } from '../web/src/api/types';
import { FileAttachment } from '../web/src/components/FileAttachment';
import { FilesView } from '../web/src/components/FilesView';
import { RoomWorkspace } from '../web/src/components/RoomWorkspace';
import * as fileDownload from '../web/src/fileDownload';

const AT = '2026-08-03T00:00:00.000Z';
const ROOM_ID = '01jz6y7n8p9q0r1s2t3v4w5x70';
const SHA_A = '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd';

function file(seq: number, filename = 'evidence.bin'): FileRecordDto {
  return {
    version: 1, room_id: ROOM_ID, seq, record_id: `${ROOM_ID}:${seq}`, at: AT,
    kind: 'file', file_id: `01jz6y7n8p9q0r1s2t3v${seq.toString(32).padStart(5, '0')}`,
    author: { identity: `cid-${seq}`, display_name: `Author ${seq}`, role: 'builder' },
    filename, mime: seq % 2 === 0 ? 'text/html' : 'application/octet-stream', size: 1,
    sha256: SHA_A, data_base64: 'QQ==', recipient_identities: ['cid-room'], source_file_id: seq,
    source_wire_id: `routing-${seq}`,
  };
}

function room(state: RoomDto['state'] = 'active'): RoomDto {
  return {
    version: 1, room_id: ROOM_ID, room_name: 'Files room', identity_name: 'cowork-files', identity_cid: 'cid-room',
    mission: { goal: 'Inspect files', briefing: 'Keep bytes inert' }, state, invites: [], seats: [], created_at: AT,
  };
}

describe('Files view', () => {
  it('shows exact-name groups and newest-first seq versions without exposing bytes or routing IDs', async () => {
    const user = userEvent.setup();
    const records = [file(1), file(2), file(3), file(4, 'Evidence.bin')];
    const { container } = render(<FilesView roomId={ROOM_ID} records={records} />);

    const groups = screen.getByRole('list', { name: 'Room files' });
    expect(within(groups).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('evidence.bin')).toBeVisible();
    expect(screen.getByText('Evidence.bin')).toBeVisible();
    expect(screen.getByText('3 versions')).toBeVisible();
    expect(container).not.toHaveTextContent('QQ==');
    expect(container).not.toHaveTextContent('routing-');
    expect(container).not.toHaveTextContent('cid-room');

    await user.click(screen.getByRole('button', { name: 'Expand versions for evidence.bin' }));
    expect(screen.getAllByText(/Version [123]/).map((node) => node.textContent)).toEqual(['Version 3', 'Version 2', 'Version 1']);
    expect(screen.getByText('text/html')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Download evidence.bin' })).toHaveLength(3);
  });

  it('caps mounted group headers and expanded versions at 500 while keeping all rows reachable', () => {
    const manyGroups = Array.from({ length: 501 }, (_, index) => file(index + 1, `group-${index + 1}`));
    const { rerender } = render(<FilesView roomId={ROOM_ID} records={manyGroups} />);
    expect(screen.getAllByRole('button', { name: /Expand versions for group-/ })).toHaveLength(500);
    fireEvent.click(screen.getByRole('button', { name: 'Show 500 earlier' }));
    expect(screen.getAllByRole('button', { name: /Expand versions for group-/ })).toHaveLength(501);

    const versions = Array.from({ length: 501 }, (_, index) => file(index + 1));
    rerender(<FilesView roomId="01jz6y7n8p9q0r1s2t3v4w5x71" records={[]} />);
    rerender(<FilesView roomId={ROOM_ID} records={versions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand versions for evidence.bin' }));
    expect(screen.getAllByText(/Version /)).toHaveLength(500);
    fireEvent.click(screen.getByRole('button', { name: 'Show 500 older versions' }));
    expect(screen.getAllByText(/Version /)).toHaveLength(501);
  });

  it('provides roving keyboard tabs and keeps closed-room files downloadable from loaded history', async () => {
    const user = userEvent.setup();
    render(<RoomWorkspace
      room={room('closed')}
      records={[file(1)]}
      historyReady
      connected={false}
      onOpenRooms={() => undefined}
      onOpenContext={() => undefined}
      onSettings={() => undefined}
    />);

    const communication = screen.getByRole('tab', { name: 'Communication' });
    communication.focus();
    await user.keyboard('{ArrowRight}');
    const files = screen.getByRole('tab', { name: 'Files' });
    expect(files).toHaveFocus();
    expect(files).toHaveAttribute('aria-selected', 'true');
    expect(communication).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Files' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Expand versions for evidence.bin' }));
    expect(screen.getByRole('button', { name: 'Download evidence.bin' })).toBeEnabled();
  });

  it('disables only the active download and reports integrity failure politely', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const download = vi.spyOn(fileDownload, 'downloadVerifiedFile').mockReturnValueOnce(pending);
    render(<>
      <FileAttachment file={{
        type: 'file', seq: 1, recordId: `${ROOM_ID}:1`, fileId: file(1).file_id, at: AT,
        author: file(1).author, filename: 'first.bin', mime: 'text/html', size: 1,
        sha256: SHA_A, dataBase64: 'QQ==',
      }} />
      <FileAttachment file={{
        type: 'file', seq: 2, recordId: `${ROOM_ID}:2`, fileId: file(2).file_id, at: AT,
        author: file(2).author, filename: 'second.bin', mime: 'text/html', size: 1,
        sha256: SHA_A, dataBase64: 'QQ==',
      }} />
    </>);

    await user.click(screen.getByRole('button', { name: 'Download first.bin' }));
    expect(screen.getByRole('button', { name: 'Download first.bin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download first.bin' })).toHaveTextContent('Preparing download');
    expect(screen.getByRole('button', { name: 'Download second.bin' })).toBeEnabled();
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download first.bin' })).toBeEnabled());
    download.mockRestore();

    const bad = file(3, 'bad.bin');
    render(<FileAttachment file={{
      type: 'file', seq: bad.seq, recordId: bad.record_id, fileId: bad.file_id, at: bad.at,
      author: bad.author, filename: bad.filename, mime: bad.mime, size: bad.size,
      sha256: '0'.repeat(64), dataBase64: bad.data_base64,
    }} />);
    const badButton = screen.getByRole('button', { name: 'Download bad.bin' });
    await user.click(badButton);
    expect(await within(badButton.closest('article')!).findByRole('status')).toHaveTextContent('File integrity check failed; download blocked.');
  });
});
