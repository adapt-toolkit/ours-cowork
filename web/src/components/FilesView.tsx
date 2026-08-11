import { useEffect, useMemo, useState } from 'react';

import type { CommunicationRecordDto } from '../api/types';
import { groupFiles, PROJECTION_PAGE_SIZE, showEarlierCount } from '../state/roomModel';
import { FileDownloadButton, formatFileSize } from './FileAttachment';

export function FilesView({ roomId, records }: { roomId: string; records: readonly CommunicationRecordDto[] }) {
  const groups = useMemo(() => groupFiles(records, roomId), [records, roomId]);
  const [visibleGroups, setVisibleGroups] = useState(PROJECTION_PAGE_SIZE);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [visibleVersions, setVisibleVersions] = useState<Record<string, number>>({});

  useEffect(() => {
    setVisibleGroups(PROJECTION_PAGE_SIZE);
    setExpanded(new Set());
    setVisibleVersions({});
  }, [roomId]);

  if (groups.length === 0) return <p className="timeline-empty">No archived files yet.</p>;
  const mounted = groups.slice(0, visibleGroups);
  return (
    <div className="files-view">
      <ul className="file-group-list" aria-label="Room files">
        {mounted.map((group) => {
          const open = expanded.has(group.groupId);
          const versionsId = `file-versions-${group.groupId}`;
          const versionCount = visibleVersions[group.groupId] ?? PROJECTION_PAGE_SIZE;
          const mountedVersions = group.versions.slice(0, versionCount);
          return (
            <li className="file-group" key={group.latest.recordId}>
              <button
                className="file-group__toggle"
                type="button"
                aria-expanded={open}
                aria-controls={versionsId}
                aria-label={`${open ? 'Collapse' : 'Expand'} versions for ${group.filename}`}
                onClick={() => setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(group.groupId)) next.delete(group.groupId); else next.add(group.groupId);
                  return next;
                })}
              >
                <span className="file-group__chevron" aria-hidden="true">›</span>
                <span className="file-group__title file-name" dir="auto">{group.filename}</span>
                <span className="file-group__count">{group.versions.length} {group.versions.length === 1 ? 'version' : 'versions'}</span>
                <span className="file-group__latest">Latest: {group.latest.author.display_name} · <RecordTime at={group.latest.at} /> · {formatFileSize(group.latest.size)}</span>
              </button>
              {open && (
                <div className="file-version-panel" id={versionsId}>
                  <ol className="file-version-list" aria-label={`Versions of ${group.filename}`}>
                    {mountedVersions.map((file) => (
                      <li className="file-version" key={file.recordId}>
                        <div className="file-version__details">
                          <strong>Version {file.version}</strong>
                          <span>{file.author.display_name} · {file.author.role}</span>
                          <span><RecordTime at={file.at} /> · {formatFileSize(file.size)}</span>
                          <span className="file-version__mime">{file.mime}</span>
                        </div>
                        <FileDownloadButton file={file} />
                      </li>
                    ))}
                  </ol>
                  {group.versions.length > mountedVersions.length && (
                    <button className="quiet-button show-earlier" type="button" onClick={() => setVisibleVersions((current) => ({
                      ...current,
                      [group.groupId]: showEarlierCount(versionCount, group.versions.length),
                    }))}>Show 500 older versions</button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {groups.length > mounted.length && (
        <button className="quiet-button show-earlier" type="button" onClick={() => setVisibleGroups((current) => showEarlierCount(current, groups.length))}>
          Show 500 earlier
        </button>
      )}
    </div>
  );
}

function RecordTime({ at }: { at: string }) {
  const date = new Date(at);
  return <time dateTime={at}>{Number.isNaN(date.valueOf()) ? at : date.toLocaleString()}</time>;
}
