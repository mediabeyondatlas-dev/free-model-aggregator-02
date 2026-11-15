// free-model-aggregator-02: one server, two client wires, and a real free model
// behind every answer.
//
// The trial gives this server a brief (MAKEFUN_PROMPT_FILE): the free model
// list with the house's quality rating per model, and the six prompts the
// env will send, in order. The server:
//
//   1. listens on 0.0.0.0 at a free port (never 8080: the env itself is there
//      on one layout);
//   2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>,
//      "catalog": <catalog>};
//   3. serves GET /v1/models (OpenAI shape for Authorization: Bearer,
//      Anthropic shape for x-api-key), POST /v1/chat/completions and POST
//      /v1/messages, each with a JSON body or with server-sent events;
//   4. answers each prompt by dialling ONE free model through the gateway.
//      OPENAI_API_KEY in the sandbox is a dummy the gateway swaps for the
//      OpenRouter key the entrant pushed; the real key never enters the
//      sandbox;
//   5. polls GET $MAKEFUN_ENV_URL/work and exits 0 when the env says done.
//      A process still running when the wall ends scores zero.
//
// ROUTING (quality is 60% of the score)
//   Every prompt is served by the highest-rated free model that meets its
//   requirements (JSON mode, tools, vision), ties broken by model id so the
//   choice is the same on a live pass and its replay. The brief's ratings are
//   the only quality signal: for a plain prompt that is the 1475-rated
//   inkling-2-small, for a JSON-mode prompt the 1303-rated nemotron-3.5-super-vl
//   (inkling takes no JSON mode).
//
// FAILOVER (10% of the score)
//   A gateway 429 or 5xx is retried on the next-best free model that meets the
//   prompt, up to three attempts a prompt; a 401 or 400 is final, because no
//   other model would answer it either. A model that refused once is not
//   picked again for a later prompt in this trial — a rate-limited model would
//   take every later prompt down with it — unless it is the only candidate
//   left. Every refusal a retry recovered from is reported in the
//   `x-makefun-upstream-failures` header, the only way the failover column can
//   see it: without the trail a recovered retry is invisible to it.
//
// DETERMINISM
//   Every choice is a function of the brief, the requests and the gateway's
//   answers: no wall clock, no unseeded randomness. Response ids and timestamps
//   are fixed or come from the provider's own answer, which the replay serves
//   back byte for byte. The trial's client waits up to 30 seconds per answer,
//   so each gateway attempt carries its own 7-second cap: three attempts
//   still fit inside that window with room to spare.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** One gateway attempt may take this long before it counts as refused. */
const ATTEMPT_TIMEOUT_MS = 7000;
/** The most gateway attempts one prompt gets, across models. */
const MAX_ATTEMPTS = 3;
/** The most refusals the failures header reports, per the trial's rules. */
const MAX_TRAIL_ROWS = 8;
/** The output cap the gateway demands on every model call. */
const DEFAULT_MAX_TOKENS = 1024;
/** The highest output cap the gateway accepts. */
const MAX_OUTPUT_TOKENS = 8192;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Models that refused a call this trial: not picked again while a spare remains. */
const refusedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  const base = GATEWAY_URL.endsWith('/v1') ? GATEWAY_URL : `${GATEWAY_URL}/v1`;
  return `${base}/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The free models that can serve a request, best first: highest rating, ties
 * broken by model id. Models that refused earlier in this trial sort last, so
 * a rate-limited model is only retried when nothing else meets the prompt.
 */
function rankedCandidates(requires: Requirement): ModelRow[] {
  const candidates = freeModels(brief).filter((model) => meetsRequirements(requires, capabilitiesOf(model)));
  candidates.sort((a, b) => {
    const refusedA = refusedModels.has(a.id) ? 1 : 0;
    const refusedB = refusedModels.has(b.id) ? 1 : 0;
    if (refusedA !== refusedB) return refusedA - refusedB;
    if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return candidates;
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, joined with the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  const fromBody = requirementsFromBody(body);
  const fromBrief = entry === undefined ? {} : entry.requires;
  return { ...fromBrief, ...fromBody };
}

/** Requirements read off a request body: its tools, its images, its JSON mode. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  const out: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = true;
  if (vision) out.vision = true;
  if (format === 'json_object' || format === 'json_schema') out.json = true;
  return out;
}

/** One client request body as a JSON object, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += piece.length;
    if (total > MAX_BODY_BYTES) return null;
    parts.push(piece);
  }
  if (parts.length === 0) return null;
  return parseBodyObject(Buffer.concat(parts).toString('utf8'));
}

/** The parsed body text as a JSON object, or null when it is not one. */
function parseBodyObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Extra headers carried on a served answer: the refusals a retry recovered from, if any. */
function trailHeaders(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, MAX_TRAIL_ROWS)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  const body = wire === 'anthropic' ? anthropicError(type, message) : openAIError(message, type, null);
  sendJson(res, status, body);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** One row of the refusals trail: the gateway's status, its error code, and the model it refused. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway's error code for a status the body did not name. */
const STATUS_CODES: Record<number, string> = {
  429: 'rate_limited',
  401: 'unauthorized',
  400: 'invalid_request_error',
};

/** A gateway refusal's error code: the body's own, else a name for its status. */
async function refusalCode(upstream: Response): Promise<string> {
  let text = '';
  try {
    text = await upstream.text();
  } catch {
    return 'unreadable_error';
  }
  const parsed = parseBodyObject(text);
  const inner = parsed !== null ? parsed.error : undefined;
  if (isRecord(inner)) {
    if (typeof inner.code === 'string' && inner.code !== '') return inner.code;
    if (typeof inner.type === 'string' && inner.type !== '') return inner.type;
  }
  if (upstream.status in STATUS_CODES) return STATUS_CODES[upstream.status];
  if (upstream.status >= 500) return 'upstream_error';
  return `http_${upstream.status}`;
}

/** The output cap a request asks for: its max_tokens, else max_completion_tokens, else none. */
function requestedCap(body: Json): number | null {
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    const cap = body[key];
    if (typeof cap === 'number' && Number.isFinite(cap)) return cap;
  }
  return null;
}

/**
 * The upstream body for one model call: the output cap the gateway demands is
 * always present, and never over its ceiling.
 */
function cappedBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  const cap = requestedCap(body);
  if (cap === null || cap < 1) out.max_tokens = DEFAULT_MAX_TOKENS;
  else if (cap > MAX_OUTPUT_TOKENS) out.max_tokens = MAX_OUTPUT_TOKENS;
  return out;
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(cappedBody(body, model)),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
}

interface Served {
  ok: true;
  model: ModelRow;
  upstream: Response;
  failures: FailureRow[];
}

interface Unserved {
  ok: false;
  failures: FailureRow[];
  lastStatus: number;
  lastCode: string;
}

/**
 * Serve one prompt through the gateway: the best free model first, then the
 * next best on a 429 or 5xx, until one answers or the attempts run out. A 401
 * or 400 ends the attempts at once — no other model would answer it either —
 * and a network failure counts as a refusal of that model.
 */
async function serve(body: Json): Promise<Served | Unserved> {
  const requires = requirementsFor(body);
  const candidates = rankedCandidates(requires);
  const failures: FailureRow[] = [];
  let lastStatus = 502;
  let lastCode = 'no_free_model';
  let attempts = 0;
  for (const model of candidates) {
    if (attempts >= MAX_ATTEMPTS) break;
    attempts += 1;
    let upstream: Response;
    try {
      upstream = await dial(model.id, body);
    } catch {
      failures.push({ status: 0, code: 'upstream_unreachable', model: model.id });
      refusedModels.add(model.id);
      lastStatus = 502;
      lastCode = 'upstream_unreachable';
      continue;
    }
    if (upstream.ok && upstream.body !== null) return { ok: true, model, upstream, failures };
    const code = await refusalCode(upstream);
    failures.push({ status: upstream.status, code, model: model.id });
    refusedModels.add(model.id);
    lastStatus = upstream.status;
    lastCode = code;
    if (upstream.status === 401 || upstream.status === 400) break;
  }
  return { ok: false, failures, lastStatus, lastCode };
}

/** A prompt no model served, as a 502 in the client's wire. */
function unserved(res: ServerResponse, wire: 'openai' | 'anthropic', result: Unserved): void {
  const detail = `the gateway refused every free model tried (${result.failures.map((f) => `${f.model ?? '?'}:${f.status}`).join(', ')})`;
  if (wire === 'anthropic') sendError(res, wire, 502, 'api_error', detail);
  else sendError(res, wire, 502, 'upstream_error', detail);
}

/** One usage count from an answer: the number it carries, or 0 when it carries none. */
function tokenCount(usage: Json, key: string): number {
  const value = usage[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A Chat Completions answer whose usage the provider left out, or whose output
 * count is 0 beside real content, repaired to the wire's floor: a whole input
 * count of at least 0 and an output count of at least 1. The content and the
 * model are the provider's own; only the usage shape is repaired.
 */
function withUsageFloor(answer: Json): Json {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : '';
  const usage = isRecord(answer.usage) ? answer.usage : {};
  const promptTokens = tokenCount(usage, 'prompt_tokens');
  const completionTokens = tokenCount(usage, 'completion_tokens');
  const output = text !== '' && completionTokens < 1 ? 1 : completionTokens;
  return { ...answer, usage: { prompt_tokens: promptTokens, completion_tokens: output, total_tokens: promptTokens + output } };
}

/** The headers of a streamed answer: no-cache SSE plus the failures trail. */
function streamHeaders(extraHeaders: Record<string, string>): Record<string, string> {
  return { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extraHeaders };
}

/** Relay the gateway's Chat Completions stream to an OpenAI client, closing it with [DONE] when the provider stopped short of one. */
async function relayOpenAIStream(res: ServerResponse, result: Served, headers: Record<string, string>): Promise<void> {
  res.writeHead(200, streamHeaders(headers));
  let sawDone = false;
  try {
    for await (const frame of openAIStreamWithModel(result.upstream.body as ReadableStream<Uint8Array>, result.model.id)) {
      if (frame.includes('data: [DONE]')) sawDone = true;
      res.write(frame);
    }
    // The wire's stream order ends with [DONE]: a provider stream that
    // stopped short of one still closes in order.
    if (!sawDone) res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
}

/** Relay the gateway's stream to an Anthropic client as the Messages event sequence. */
async function relayAnthropicStream(res: ServerResponse, result: Served, headers: Record<string, string>): Promise<void> {
  res.writeHead(200, streamHeaders(headers));
  try {
    for await (const event of anthropicEventsFromOpenAI(result.upstream.body as ReadableStream<Uint8Array>, result.model.id)) res.write(event);
  } finally {
    res.end();
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that meets it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const result = await serve(body);
  if (!result.ok) return unserved(res, 'openai', result);
  const headers = trailHeaders(result.failures);
  if (body.stream === true) {
    await relayOpenAIStream(res, result, headers);
    return;
  }
  const answer: unknown = await result.upstream.json();
  sendJson(res, 200, openAIJsonWithModel(withUsageFloor(isRecord(answer) ? answer : {}), result.model.id), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const upstreamBody = anthropicToOpenAI(body, 'auto');
  const result = await serve(upstreamBody);
  if (!result.ok) return unserved(res, 'anthropic', result);
  const headers = trailHeaders(result.failures);
  if (body.stream === true) {
    await relayAnthropicStream(res, result, headers);
    return;
  }
  const answer: unknown = await result.upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, result.model.id), headers);
}

/** One route: the method and path it answers, and the handler that answers it. */
interface Route {
  method: string;
  path: string;
  run: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/v1/models', run: (req, res) => models(req, res) },
  { method: 'POST', path: '/v1/chat/completions', run: (req, res) => chat(req, res) },
  { method: 'POST', path: '/v1/messages', run: (req, res) => messages(req, res) },
];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const route = ROUTES.find((r) => r.method === req.method && r.path === url.pathname);
  if (route !== undefined) {
    await route.run(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const payload = { protocol_version: PROTOCOL_VERSION, port, catalog: report };
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${detail}`);
  }
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** One poll tick: ask the env whether the trial is done, and stop the server when it is. */
async function pollOnce(server: Server, timer: NodeJS.Timeout): Promise<void> {
  const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
  if (res.status !== 200) return;
  const work: unknown = await res.json();
  if (!isRecord(work) || work.done !== true) return;
  clearInterval(timer);
  server.close();
  process.exit(0);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void pollOnce(server, timer)
      .catch(() => {
        // The env is not reachable yet: try again on the next tick.
      })
      .finally(() => {
        inFlight = false;
      });
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
