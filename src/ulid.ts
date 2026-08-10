import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** Lowercase Crockford ULID: 48-bit timestamp + 80 bits of fresh entropy. */
export function generateUlid(): string {
  let time = Date.now();
  const output = new Array<string>(26);
  for (let index = 9; index >= 0; index -= 1) {
    output[index] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  const entropy = randomBytes(10);
  let bits = 0;
  let value = 0;
  let byteIndex = 0;
  for (let index = 10; index < 26; index += 1) {
    while (bits < 5) {
      value = (value << 8) | entropy[byteIndex++]!;
      bits += 8;
    }
    bits -= 5;
    output[index] = CROCKFORD[(value >>> bits) & 31]!;
  }
  return output.join('');
}
