import { useEffect, useMemo, useRef, useState } from 'react';

import type { CommunicationRecordDto } from '../api/types';
import { newestRows, PROJECTION_PAGE_SIZE, projectChat, showEarlierCount } from '../state/roomModel';

export function ChatTimeline({ roomId, records, historyReady, visible }: {
  roomId: string;
  records: readonly CommunicationRecordDto[];
  historyReady: boolean;
  visible: boolean;
}) {
  const rows = useMemo(() => projectChat(records), [records]);
  const [visibleCount, setVisibleCount] = useState(PROJECTION_PAGE_SIZE);
  const [announcement, setAnnouncement] = useState('');
  const observed = useRef<{ roomId?: string; maxSeq: number; ready: boolean }>({ maxSeq: 0, ready: false });

  useEffect(() => {
    setVisibleCount(PROJECTION_PAGE_SIZE);
  }, [roomId]);

  useEffect(() => {
    const maxSeq = rows.at(-1)?.seq ?? 0;
    const previous = observed.current;
    if (previous.roomId !== roomId || !historyReady || !previous.ready) {
      observed.current = { roomId, maxSeq, ready: historyReady };
      setAnnouncement('');
      return;
    }
    const additions = rows.filter((row) => row.seq > previous.maxSeq).length;
    observed.current = { roomId, maxSeq: Math.max(previous.maxSeq, maxSeq), ready: true };
    setAnnouncement(visible && additions > 0
      ? `${additions} new ${additions === 1 ? 'message' : 'messages'}`
      : '');
  }, [historyReady, roomId, rows, visible]);

  const mounted = newestRows(rows, visibleCount);
  return (
    <div className="chat-timeline">
      {rows.length === 0 && <p className="timeline-empty">No archived communication yet.</p>}
      {rows.length > mounted.length && (
        <button className="quiet-button show-earlier" type="button" onClick={() => setVisibleCount((current) => showEarlierCount(current, rows.length))}>
          Show 500 earlier
        </button>
      )}
      <ul className="chat-list" aria-label="Room communication">
        {mounted.map((row) => row.type === 'briefing' ? (
          <li className="chat-row chat-row--briefing" key={row.recordId}>
            <div className="chat-row__meta"><strong>Mission briefing</strong><RecordMeta seq={row.seq} at={row.at} /></div>
            <p className="chat-row__text">{row.text}</p>
          </li>
        ) : (
          <li className={`chat-row chat-row--${row.speaker}`} key={row.recordId}>
            <div className="chat-row__meta"><strong>{row.author.display_name}</strong><span>{row.speaker === 'room' ? 'Room voice' : row.author.role}</span><RecordMeta seq={row.seq} at={row.at} /></div>
            <p className="chat-row__text">{row.text}</p>
          </li>
        ))}
      </ul>
      <p className="visually-hidden" role="status" aria-label="New room messages" aria-live="polite" aria-atomic="true">{announcement}</p>
    </div>
  );
}

function RecordMeta({ seq, at }: { seq: number; at: string }) {
  const date = new Date(at);
  return <><code>#{seq}</code><time dateTime={at}>{Number.isNaN(date.valueOf()) ? at : date.toLocaleString()}</time></>;
}
