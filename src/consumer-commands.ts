import { z } from 'zod';
import Ajv, { type ValidateFunction } from 'ajv';
import type { CommandContext, JsonValue } from '@ours.network/sdk';
import { readPrivateConfigFile, writePrivateConfigFile } from './private-config.ts';

export const ConsumerCommandNameSchema = z.string().max(128).regex(/^consumer\.[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
export const ConsumerDefinitionSchema = z.object({
  name: ConsumerCommandNameSchema,
  description: z.string().min(1).max(1024),
  input_schema: z.record(z.unknown()),
  handler: z.string().min(1).max(128),
}).strict();
export const StoredConsumerDefinitionSchema = ConsumerDefinitionSchema.extend({
  source: z.enum(['rest', 'local']), revision: z.number().int().positive().safe(),
}).strict();
export type ConsumerDefinition = z.infer<typeof ConsumerDefinitionSchema>;
export type StoredConsumerDefinition = z.infer<typeof StoredConsumerDefinitionSchema>;
export const ConsumerConfigurationSchema = z.object({
  handlers: z.array(z.object({
    id: z.string().min(1).max(128),
    url: z.string().url(),
    token_file: z.string().min(1),
  }).strict()).max(64),
  definitions_file: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).default(5000),
}).strict();
export type ConsumerConfiguration = z.infer<typeof ConsumerConfigurationSchema>;
export const MAX_CONSUMER_ARGUMENT_BYTES = 64 * 1024;
export const MAX_CONSUMER_RESPONSE_BYTES = 256 * 1024;
const LocalFileSchema = z.object({
  version: z.literal(1),
  rooms: z.array(z.object({
    room_id: z.string().regex(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/),
    commands: z.array(ConsumerDefinitionSchema).max(64),
  }).strict()).max(256),
}).strict();

/** Exact destinations and credential paths are selected by the host. Consumers provision tokens over protected management RPC. */
export class ConsumerHandlers {
  private readonly targets = new Map<string, { url: string; token?: string; tokenFile: string }>();
  private readonly validators = new Map<string, ValidateFunction>();
  constructor(private readonly config?: ConsumerConfiguration) {
    for (const handler of config?.handlers ?? []) {
      const url = new URL(handler.url);
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
      if (url.username || url.password || url.hash || url.search
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        throw new Error('consumer handler requires HTTPS (HTTP only for loopback), without URL credentials, query or fragment');
      }
      if (this.targets.has(handler.id)) throw new Error('duplicate consumer handler ID');
      let token: string | undefined;
      try {
        token = readPrivateConfigFile(handler.token_file, 4096).toString('utf8').trim();
        if (!/^[\x21-\x7e]{16,4096}$/.test(token)) throw new Error('invalid consumer handler token file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.targets.set(handler.id, { url: url.href, tokenFile: handler.token_file, ...(token ? { token } : {}) });
    }
    this.localDefinitions(); // Validate the complete local generation before startup effects.
  }

  provisionCredential(input: unknown): { handler: string; configured: true } {
    const request = z.object({ handler: z.string().min(1).max(128), token: z.string().regex(/^[\x21-\x7e]{16,4096}$/) }).strict().parse(input);
    const target = this.targets.get(request.handler);
    if (!target) throw new Error('unknown consumer handler');
    writePrivateConfigFile(target.tokenFile, request.token);
    this.targets.set(request.handler, { ...target, token: request.token });
    return { handler: request.handler, configured: true };
  }

  validate(input: unknown): ConsumerDefinition {
    const definition = ConsumerDefinitionSchema.parse(input);
    if (!this.targets.has(definition.handler)) throw new Error('unknown configured consumer handler');
    const encoded = JSON.stringify(definition.input_schema);
    if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error('consumer input schema exceeds 16 KiB');
    // No external resolution, async validation, or regular-expression execution.
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 16) throw new Error('consumer input schema is too deeply nested');
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['$ref', '$id', '$async', 'pattern', 'patternProperties', 'format'].includes(key)) {
          throw new Error('consumer input schema contains an unsupported keyword');
        }
        visit(child, depth + 1);
      }
    };
    visit(definition.input_schema);
    if (definition.input_schema.type !== 'object' || definition.input_schema.additionalProperties !== false) {
      throw new Error('consumer input schema must be an object with additionalProperties false');
    }
    if (!this.validators.has(encoded)) {
      // Bound the cache independently of registration churn.
      if (this.validators.size >= 256) this.validators.clear();
      this.validators.set(encoded, new Ajv({ strict: true, validateFormats: false, allErrors: false }).compile(definition.input_schema));
    }
    return definition;
  }

  localDefinitions(): Map<string, ConsumerDefinition[]> {
    const result = new Map<string, ConsumerDefinition[]>();
    if (!this.config?.definitions_file) return result;
    const file = LocalFileSchema.parse(JSON.parse(readPrivateConfigFile(this.config.definitions_file, 1024 * 1024).toString('utf8')));
    for (const room of file.rooms) {
      if (result.has(room.room_id)) throw new Error('duplicate room in local consumer definitions');
      const commands = room.commands.map((definition) => this.validate(definition));
      if (new Set(commands.map((command) => command.name)).size !== commands.length) throw new Error('duplicate local consumer command');
      result.set(room.room_id, commands);
    }
    return result;
  }

  async invoke(definition: StoredConsumerDefinition, roomId: string, args: JsonValue, context: Readonly<CommandContext>): Promise<JsonValue> {
    try { this.validate(ConsumerDefinitionSchema.parse({ name: definition.name, description: definition.description, input_schema: definition.input_schema, handler: definition.handler })); }
    catch { return { ok: false, error: 'consumer_handler_unavailable' }; }
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_CONSUMER_ARGUMENT_BYTES
      || !this.validators.get(JSON.stringify(definition.input_schema))!(args)) {
      return { ok: false, error: 'invalid_params' };
    }
    const target = this.targets.get(definition.handler)!;
    if (!target.token) return { ok: false, error: 'consumer_handler_unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config?.timeout_ms ?? 5000);
    try {
      const response = await fetch(target.url, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ version: 1, command: definition.name, registration_revision: definition.revision,
          request_id: context.request_wire_id, room_id: roomId, caller_cid: context.sender_cid, arguments: args }),
      });
      if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        return { ok: false, error: 'consumer_http_error', execution: 'unknown' };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CONSUMER_RESPONSE_BYTES) {
          await reader.cancel();
          return { ok: false, error: 'consumer_response_too_large', execution: 'unknown' };
        }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const parsed = z.union([
        z.object({ ok: z.literal(true), result: z.unknown() }).strict().refine((value) => Object.hasOwn(value, 'result')),
        z.object({ ok: z.literal(false), error: z.string().min(1).max(256) }).strict(),
      ]).safeParse(body);
      return parsed.success ? body as JsonValue : { ok: false, error: 'consumer_invalid_response', execution: 'unknown' };
    } catch {
      return { ok: false, error: controller.signal.aborted ? 'consumer_timeout' : 'consumer_request_failed', execution: 'unknown' };
    } finally { clearTimeout(timer); }
  }
}
