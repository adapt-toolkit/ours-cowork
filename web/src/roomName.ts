export const MAX_ROOM_NAME_CHARACTERS = 64;

export function normalizeRoomName(value: string): string {
  return value.trim().normalize('NFC');
}

export function roomNameError(value: string): string | undefined {
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return 'Name cannot contain control or format characters.';
  const normalized = normalizeRoomName(value);
  const length = Array.from(normalized).length;
  if (length < 1) return 'Name is required.';
  if (length > MAX_ROOM_NAME_CHARACTERS) return `Name must be at most ${MAX_ROOM_NAME_CHARACTERS} characters.`;
  return undefined;
}

export function isNormalizedRoomName(value: unknown): value is string {
  return typeof value === 'string'
    && value === normalizeRoomName(value)
    && roomNameError(value) === undefined;
}
