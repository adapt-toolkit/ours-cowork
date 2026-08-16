import { describe, expect, it, vi } from 'vitest';

import {
  API_DOCS_PATH,
  API_DOCS_SCRIPT_PATH,
  OPENAPI_DOCUMENT_PATH,
  RPC_PATH,
  apiDocsAsset,
  buildOpenApiDocument,
} from '../src/openapi.ts';

/**
 * The documentation UI ships as inert daemon-served text, so these tests mount
 * the real page and run the real script against a stubbed loopback fetch.
 */
function mountDocs(fetchImpl: typeof fetch): void {
  const page = apiDocsAsset(API_DOCS_PATH)!.body;
  document.documentElement.innerHTML = page
    .replace(/^[\s\S]*?<body>/, '')
    .replace(/<\/body>[\s\S]*$/, '');
  vi.stubGlobal('fetch', fetchImpl);
  // eslint-disable-next-line no-new-func -- the served script is a plain classic script.
  new Function(apiDocsAsset(API_DOCS_SCRIPT_PATH)!.body)();
}

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  } as Response;
}

function discriminatorMapping(specification: Record<string, unknown>): Record<string, string> {
  const paths = specification.paths as Record<string, { post: { requestBody: { content: Record<
    string, { schema: { discriminator: { mapping: Record<string, string> } } }> } } }>;
  return paths[RPC_PATH]!.post.requestBody.content['application/json']!.schema.discriminator.mapping;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('api documentation UI', () => {
  it('renders every documented route and RPC method from the served schema', async () => {
    const document_ = buildOpenApiDocument();
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(OPENAPI_DOCUMENT_PATH);
      return jsonResponse(document_);
    });
    mountDocs(fetchStub as unknown as typeof fetch);
    await settle();

    const root = document.getElementById('api-docs')!;
    expect(root.querySelector('h1')?.textContent).toBe('ours-cowork room management API');
    const routes = [...root.querySelectorAll('.route code')].map((node) => node.textContent);
    expect(routes).toEqual(Object.keys(document_.paths as Record<string, unknown>));

    const methods = [...root.querySelectorAll('details.method summary .name')].map((node) => node.textContent);
    const documented = discriminatorMapping(document_);
    expect(methods.sort()).toEqual(Object.keys(documented).sort());

    const createPanel = [...root.querySelectorAll('details.method')]
      .find((panel) => panel.querySelector('summary .name')?.textContent === 'room.create')!;
    expect(createPanel.querySelector('td.param')?.textContent).toContain('name');
    expect(createPanel.querySelector('textarea')?.value).toContain('"method": "room.create"');
  });

  it('sends the edited envelope to the real RPC route and shows the response', async () => {
    const calls: RequestInit[] = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === OPENAPI_DOCUMENT_PATH) return jsonResponse(buildOpenApiDocument());
      expect(String(input)).toBe(RPC_PATH);
      calls.push(init!);
      return jsonResponse({ version: 1, id: 'req-1', result: [] });
    });
    mountDocs(fetchStub as unknown as typeof fetch);
    await settle();

    const listPanel = [...document.querySelectorAll('details.method')]
      .find((panel) => panel.querySelector('summary .name')?.textContent === 'room.list')!;
    (listPanel.querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect((calls[0]!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.body)).method).toBe('room.list');
    expect(listPanel.querySelector('.status')?.textContent).toBe('HTTP 200');
    expect(listPanel.querySelector('pre')?.textContent).toContain('"result": []');
  });

  it('reports a schema that cannot be loaded instead of rendering a blank page', async () => {
    mountDocs(vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch);
    await settle();
    expect(document.querySelector('.error')?.textContent).toContain(OPENAPI_DOCUMENT_PATH);
  });
});
