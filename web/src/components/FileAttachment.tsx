import { useState } from 'react';

import { downloadVerifiedFile, FILE_INTEGRITY_ERROR, FileIntegrityError } from '../fileDownload';
import type { FileRow } from '../state/roomModel';

export function FileAttachment({ file }: { file: FileRow }) {
  return (
    <article className="file-attachment">
      <div className="file-attachment__glyph" aria-hidden="true">↓</div>
      <div className="file-attachment__body">
        <strong className="file-name" dir="auto">{file.filename}</strong>
        <span>{formatFileSize(file.size)}</span>
      </div>
      <FileDownloadButton file={file} />
    </article>
  );
}

export function FileDownloadButton({ file }: { file: FileRow }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');

  async function download() {
    if (pending) return;
    setPending(true);
    setStatus('');
    try {
      await downloadVerifiedFile(file);
    } catch (error) {
      setStatus(error instanceof FileIntegrityError ? FILE_INTEGRITY_ERROR : 'Download failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="file-download">
      <button className="secondary-button file-download__button" type="button" disabled={pending} aria-label={`Download ${file.filename}`} onClick={() => void download()}>
        {pending ? 'Preparing download' : 'Download'}
      </button>
      <span className="file-download__status" role="status" aria-live="polite">{status}</span>
    </div>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
