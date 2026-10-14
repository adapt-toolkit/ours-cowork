import {
  HEARTBEAT_ACTIVE_STATUS,
  HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
  type CommunicationRecord,
  type Room,
} from './contracts.ts';

/**
 * Room inactivity heartbeat rules. Everything here is pure so the scheduler in
 * RoomService and the relay pump apply one definition of eligibility, activity
 * and timing.
 *
 * Activity boundary: a participant discussion record is a `chat` message with
 * non-blank text, or a file. That covers native seat intake, start_thread roots,
 * operator room.message, registered-role room.say and REST uploads — each an
 * explicit authored act. Room-generated briefings, membership notices,
 * heartbeats, intake-rejection notices and close notices never count.
 */

export type HeartbeatPolicy = NonNullable<Room['heartbeat']>;

const MINUTE_MS = 60_000;

/** The policy a room behaves under; a room predating the feature is disabled. */
export function effectiveHeartbeatPolicy(room: Room): { enabled: boolean; interval_minutes: number } {
  return room.heartbeat === undefined
    ? { enabled: false, interval_minutes: HEARTBEAT_DEFAULT_INTERVAL_MINUTES }
    : { enabled: room.heartbeat.enabled, interval_minutes: room.heartbeat.interval_minutes };
}

/** Only an active, unlocked in_progress room with an enabled policy is monitored. */
export function heartbeatEligible(room: Room): room is Room & { heartbeat: HeartbeatPolicy } {
  return room.state === 'active'
    && room.status === HEARTBEAT_ACTIVE_STATUS
    && room.heartbeat?.enabled === true
    && room.lifecycle_request?.state !== 'pending';
}

export function isDiscussionRecord(record: CommunicationRecord): boolean {
  if (record.kind === 'file') return true;
  return record.kind === 'message' && record.category === 'chat' && record.text.trim().length > 0;
}

/**
 * Whether a status/activation change moves the room across the monitoring
 * boundary. Such a transition starts a new generation and a fresh window.
 */
export function crossesMonitoringBoundary(before: Room, after: Room): boolean {
  const monitored = (room: Room) => room.state === 'active' && room.status === HEARTBEAT_ACTIVE_STATUS;
  return monitored(before) !== monitored(after);
}

/** Start a new generation and inactivity window. Activity before it no longer matters. */
export function restartHeartbeatWindow(policy: HeartbeatPolicy, at: string, archiveTailSeq: number): HeartbeatPolicy {
  const { activity_at: _at, ...rest } = policy;
  return { ...rest, generation: policy.generation + 1, anchor_at: at, observed_seq: archiveTailSeq };
}

export interface HeartbeatBasisInput {
  policy: HeartbeatPolicy;
  /** `at` of the latest heartbeat record emitted in the current generation. */
  lastHeartbeatAt?: string;
  /** Host time first observed for discussion the policy has not recorded (crash window). */
  unrecordedDiscussionAt?: string;
}

/**
 * Latest host-clock instant inactivity is measured from. `clamp` maps each
 * component that lies in the future (clock rewind) to its first observation,
 * component by component, so a later heartbeat still advances the basis.
 */
export function heartbeatBasis(
  input: HeartbeatBasisInput,
  clamp: (component: string, ms: number) => number = (_component, ms) => ms,
): number {
  const components: Array<[string, string | undefined]> = [
    ['anchor', input.policy.anchor_at],
    ['activity', input.policy.activity_at],
    ['heartbeat', input.lastHeartbeatAt],
    ['unrecorded', input.unrecordedDiscussionAt],
  ];
  return Math.max(...components.map(([component, at]) =>
    at === undefined ? -Infinity : clamp(component, Date.parse(at))));
}

export function heartbeatIntervalMs(policy: { interval_minutes: number }): number {
  return policy.interval_minutes * MINUTE_MS;
}

export function heartbeatText(intervalMinutes: number): string {
  const span = intervalMinutes === 1 ? '1 minute' : `${intervalMinutes} minutes`;
  return [
    `Room heartbeat: no participant discussion for ${span} while this room is in progress.`,
    'This is a routine check-in, not evidence that the room is stuck, and it never changes the room status.',
    'Participants: if you have progress, a blocker, or a next action, share it briefly.',
    'Moderator/coordinator: assess the actual work. If completion is established, set the room status to done with room.settings; otherwise post a useful status, blocker or next action.',
  ].join(' ');
}
