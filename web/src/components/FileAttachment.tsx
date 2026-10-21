import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { downloadVerifiedFile, FILE_INTEGRITY_ERROR, FileIntegrityError } from '../fileDownload';
import type { FileRow } from '../state/roomModel';

export type FileContentLoader = (file: FileRow, signal: AbortSignal) => Promise<string>;
export const FileContentContext = createContext<FileContentLoader | undefined>(undefined);

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
  const loadContent = useContext(FileContentContext);
  const request = useRef<AbortController>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    setPending(false);
    setStatus('');
    return () => request.current?.abort();
  }, [file.recordId, loadContent]);

  async function download() {
    if (pending) return;
    setPending(true);
    setStatus('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const dataBase64 = file.dataBase64 ?? await loadContent?.(file, controller.signal);
      controller.signal.throwIfAborted();
      await downloadVerifiedFile({...file, dataBase64}, undefined, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus(error instanceof FileIntegrityError ? FILE_INTEGRITY_ERROR : 'Download failed.');
    } finally {
      if (!controller.signal.aborted) setPending(false);
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
