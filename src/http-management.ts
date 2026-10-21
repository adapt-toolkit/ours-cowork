import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** A server-issued credential grants operator room administration, not daemon control. */
export function createManagementAuthorizer(env: NodeJS.ProcessEnv): ((request: IncomingMessage) => Promise<boolean>) | undefined {
  if (env.OURS_COWORK_HTTP_MANAGEMENT === undefined || env.OURS_COWORK_HTTP_MANAGEMENT === '0') return undefined;
  if (env.OURS_COWORK_HTTP_MANAGEMENT !== '1') throw new Error('OURS_COWORK_HTTP_MANAGEMENT must be 0 or 1');
  const expectedInstanceId = env.OURS_DAEMON_ID;
  if (!env.OURS_DAEMON_URL || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(expectedInstanceId ?? ''))
    throw new Error('HTTP management requires a fixed daemon endpoint and instance');
  const url = new URL(env.OURS_DAEMON_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('HTTP management requires an HTTP daemon URL without credentials, query or fragment');
  const endpoint = url.toString();
  return async request => {
    const token = request.headers['x-ours-api-token'];
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) return false;
    if (request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-ours-api-token').length !== 1) return false;
    try {
      // The SDK checks /selection without a credential before sending it to the
      // fixed instance. No redirects, auth cache, fallback profile or new token.
      const { attachOursClient } = await import('@ours.network/sdk/client');
      const client = await attachOursClient({ endpoint, expectedInstanceId: expectedInstanceId!, token,
        sessionMode: 'external', leaseToken: `cowork-management-auth-${randomUUID()}`, env: {}, requestSignal: AbortSignal.timeout(5000) });
      try { return Array.isArray(await client.identities()); }
      finally { await client.close(); }
    } catch { return false; }
  };
}
