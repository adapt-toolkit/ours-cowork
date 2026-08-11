import type { FileRow } from './state/roomModel';

export const FILE_INTEGRITY_ERROR = 'File integrity check failed; download blocked.';
export const DOWNLOAD_MIME = 'application/octet-stream';

export class FileIntegrityError extends Error {
  constructor() {
    super(FILE_INTEGRITY_ERROR);
    this.name = 'FileIntegrityError';
  }
}

export interface DownloadEnvironment {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createAnchor(): HTMLAnchorElement;
  schedule(callback: () => void): void;
}

export async function verifiedFileBytes(file: Pick<FileRow, 'dataBase64' | 'size' | 'sha256'>): Promise<Uint8Array> {
  const bytes = decodeCanonicalBase64(file.dataBase64);
  if (bytes.byteLength !== file.size) throw new FileIntegrityError();

  let digest: ArrayBuffer;
  try {
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput.buffer);
  } catch {
    throw new FileIntegrityError();
  }
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== file.sha256) throw new FileIntegrityError();
  return bytes;
}

export function safeDownloadName(filename: string): string {
  const withoutUnsafe = filename
    .replace(/[\\/]/gu, '_')
    .replace(/[\p{Cc}\p{Cf}]/gu, '_')
    .replace(/[ .]+$/gu, (suffix) => '_'.repeat(suffix.length));
  return withoutUnsafe.length > 0 ? withoutUnsafe : 'download';
}

export async function downloadVerifiedFile(
  file: Pick<FileRow, 'dataBase64' | 'size' | 'sha256' | 'filename'>,
  environment: DownloadEnvironment = browserDownloadEnvironment(),
): Promise<void> {
  const bytes = await verifiedFileBytes(file);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = environment.createObjectURL(new Blob([copy.buffer], { type: DOWNLOAD_MIME }));
  try {
    const anchor = environment.createAnchor();
    anchor.href = url;
    anchor.download = safeDownloadName(file.filename);
    anchor.hidden = true;
    anchor.click();
  } finally {
    environment.schedule(() => environment.revokeObjectURL(url));
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FileIntegrityError();
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new FileIntegrityError();
  }
  if (btoa(binary) !== value) throw new FileIntegrityError();
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function browserDownloadEnvironment(): DownloadEnvironment {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement('a'),
    schedule: (callback) => setTimeout(callback, 0),
  };
}
