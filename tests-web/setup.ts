import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no SubtleCrypto, and Node 20 rejects BufferSources from jsdom's VM realm.
const subtle = new Proxy(webcrypto.subtle, {
  get(target, property) {
    if (property === 'digest') {
      return (algorithm: AlgorithmIdentifier, data: BufferSource) => {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        return target.digest(algorithm, Buffer.from(bytes));
      };
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const crypto = new Proxy(webcrypto, {
  get(target, property) {
    if (property === 'subtle') return subtle;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: crypto });

afterEach(() => cleanup());
