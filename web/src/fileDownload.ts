import type { FileRow } from './state/roomModel';
import { isHistoryDto } from './api/types';

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
  if (typeof file.dataBase64 !== 'string') throw new FileIntegrityError();
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
  signal?: AbortSignal,
): Promise<void> {
  const bytes = await verifiedFileBytes(file);
  signal?.throwIfAborted();
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

/** Fetch exactly the selected immutable record through the existing authenticated RPC. */
export async function loadFileContent(
  file: FileRow,
  call: (method: string, params: Record<string, unknown>, options: {signal: AbortSignal}) => Promise<unknown>,
  signal: AbortSignal,
): Promise<string> {
  const roomId = file.recordId.split(':')[0]!;
  const records = await call('room.history', {room_id: roomId, after: file.seq - 1, limit: 1}, {signal});
  signal.throwIfAborted();
  if (!isHistoryDto(records) || records.length !== 1) throw new FileIntegrityError();
  const record = records[0]!;
  if (record.kind !== 'file' || record.room_id !== roomId || record.record_id !== file.recordId
    || record.seq !== file.seq || record.file_id !== file.fileId || record.sha256 !== file.sha256
    || record.size !== file.size || record.filename !== file.filename || record.mime !== file.mime
    || typeof record.data_base64 !== 'string') throw new FileIntegrityError();
  return record.data_base64;
}
