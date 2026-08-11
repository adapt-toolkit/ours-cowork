import { describe, expect, it, vi } from 'vitest';

import {
  DOWNLOAD_MIME,
  downloadVerifiedFile,
  FILE_INTEGRITY_ERROR,
  safeDownloadName,
  verifiedFileBytes,
  type DownloadEnvironment,
} from '../web/src/fileDownload';

const SHA_A = '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd';
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('verified file download', () => {
  it('accepts canonical verified bytes including zero bytes', async () => {
    await expect(verifiedFileBytes({ dataBase64: 'QQ==', size: 1, sha256: SHA_A }))
      .resolves.toEqual(Uint8Array.of(65));
    await expect(verifiedFileBytes({ dataBase64: '', size: 0, sha256: SHA_EMPTY }))
      .resolves.toEqual(new Uint8Array());
  });

  it.each([
    ['invalid base64', '***=', 1, SHA_A],
    ['non-canonical base64', 'QR==', 1, SHA_A],
    ['size mismatch', 'QQ==', 2, SHA_A],
    ['hash mismatch', 'QQ==', 1, SHA_EMPTY],
  ])('blocks %s before a download is created', async (_label, dataBase64, size, sha256) => {
    await expect(verifiedFileBytes({ dataBase64, size, sha256 })).rejects.toThrow(FILE_INTEGRITY_ERROR);
  });

  it('downloads only a verified octet-stream Blob with a safe derived name and prompt revocation', async () => {
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined);
    const revoke = vi.fn();
    let createdBlob: Blob | undefined;
    let scheduled: (() => void) | undefined;
    const environment: DownloadEnvironment = {
      createObjectURL(blob) { createdBlob = blob; return 'blob:verified'; },
      revokeObjectURL: revoke,
      createAnchor: () => anchor,
      schedule(callback) { scheduled = callback; },
    };

    await downloadVerifiedFile({
      filename: 'unsafe\u200e.html. ', dataBase64: 'QQ==', size: 1, sha256: SHA_A,
    }, environment);

    expect(createdBlob).toMatchObject({ size: 1, type: DOWNLOAD_MIME });
    expect(anchor.href).toBe('blob:verified');
    expect(anchor.download).toBe('unsafe_.html__');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    scheduled?.();
    expect(revoke).toHaveBeenCalledWith('blob:verified');
  });

  it('derives inert platform-safe names without changing display/grouping input', () => {
    expect(safeDownloadName('a\u0000b\u2060.txt. ')).toBe('a_b_.txt__');
    expect(safeDownloadName('')).toBe('download');
    expect(safeDownloadName('folder/name')).toBe('folder_name');
  });
});
