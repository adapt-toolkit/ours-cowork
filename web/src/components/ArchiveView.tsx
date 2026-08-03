import { useMemo } from 'react';

import type { CommunicationRecordDto } from '../api/types';
import { mergeRecords, projectEvents } from '../state/roomModel';

export function ArchiveView({ records, mode }: {
  records: readonly CommunicationRecordDto[];
  mode: 'archive' | 'events';
}) {
  const rows = useMemo(() => mode === 'events' ? projectEvents(records) : mergeRecords([], records), [mode, records]);
  if (rows.length === 0) return <p className="timeline-empty">No {mode === 'events' ? 'operational events' : 'archive records'} loaded.</p>;
  return (
    <ul className="record-list" aria-label={mode === 'events' ? 'Operational events' : 'Complete archive'}>
      {rows.map((record) => {
        const details = compactDetails(record);
        return (
          <li className="record-row" key={record.record_id}>
            <header><code>#{record.seq}</code><strong>{record.kind.replaceAll('_', ' ')}</strong>{'status' in record && <span className={`record-status record-status--${record.status}`}>{record.status}</span>}<time dateTime={record.at}>{formatDate(record.at)}</time></header>
            {record.kind === 'message' && <p>{record.text}</p>}
            <pre>{JSON.stringify(details, null, 2)}</pre>
          </li>
        );
      })}
    </ul>
  );
}

function compactDetails(record: CommunicationRecordDto): Record<string, unknown> {
  const { version: _version, room_id: _roomId, seq: _seq, record_id: _recordId, at: _at, text: _text, ...details } = record.kind === 'message'
    ? record
    : { ...record, text: undefined };
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
