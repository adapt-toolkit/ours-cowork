import { useEffect, useMemo, useState } from 'react';
import { CoworkApp, type RpcClient } from './App';
import { rpcCall } from './api/rpc';

/** Credentials live only in this mounted browser session, never browser storage. */
export function BrowserSession() {
  const [mode, setMode] = useState<'loading' | 'local' | 'authenticated' | 'failed'>('loading');
  const [input, setInput] = useState('');
  const [credential, setCredential] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch(new URL('.', location.href).pathname + 'client-config', { redirect: 'error', credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        const config: unknown = await response.json();
        if (!config || typeof config !== 'object' || !('authenticatedBrowser' in config) || typeof config.authenticatedBrowser !== 'boolean') throw new Error('invalid');
        if (!controller.signal.aborted) setMode(config.authenticatedBrowser ? 'authenticated' : 'local');
      }).catch(() => { if (!controller.signal.aborted) setMode('failed'); });
    return () => controller.abort();
  }, []);
  const rpc = useMemo<RpcClient>(() => ({
    call: (method, params, options) => rpcCall(method, params, { signal: options?.signal, browserCredential: credential }),
  }), [credential]);
  if (mode === 'local') return <CoworkApp />;
  if (mode === 'authenticated' && credential) return <CoworkApp rpc={rpc} />;
  if (mode === 'loading') return <main><p>Connecting to Cowork…</p></main>;
  if (mode === 'failed') return <main><p role="alert">Cowork connection settings are unavailable. Reload to try again.</p></main>;
  return <main className="connection-panel">
    <h1>Connect to Cowork</h1>
    <p>Your server credential grants operator access to rooms, including changes and deletion. It stays in memory until this page is closed or reloaded.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        await rpcCall('room.list', {}, { browserCredential: input });
        setCredential(input); setInput('');
      } catch { setError('Connection failed. Check your server credential and try again.'); }
      finally { setBusy(false); }
    }}>
      <label htmlFor="server-credential">Server credential</label>
      <input id="server-credential" type="password" autoComplete="off" value={input} onChange={event => setInput(event.target.value)} required disabled={busy} />
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  </main>;
}
