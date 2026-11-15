// The brief's two documents, the free model list, and the catalog.
//
// A trial's brief (the path in MAKEFUN_PROMPT_FILE) is prose with two JSON
// documents in it. The prose around them does not matter: this file finds each
// document by the `schema` member it carries under this contest's prefix.
//
//   - the free model list (`free-model-aggregator-02/models/v1`): one row per
//     model, keyed by the id the gateway routes (`openrouter/<vendor>/<model>
//     :free`), with the model's public rating in milli-points, what it can do
//     (tools, vision, JSON mode, context length) and its free flag. Only a
//     free model may serve a prompt; this server never routes a paid one.
//   - the six prompts (`free-model-aggregator-02/prompts/v1`): the prompts the
//     house's client will send, in order, each with its id, its api (openai or
//     anthropic), whether it streams, its weight (1 or 2) and the requirements
//     a model must meet to serve it.
//
// A brief may spell the model list `models` or `ratings` and the prompts
// `prompts` or `manifest`, and one document may carry both; a document is
// found by the arrays it carries, never by a name alone.
//
// Everything here is deterministic: no clock and no randomness, so
// `node main.ts --list` and the register body build the same document, byte
// for byte, on a live pass and on its replay.

import { readFileSync } from 'node:fs';

export const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1';
export const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1';

/** Every schema this contest's brief writes names this prefix. */
const SCHEMA_PREFIX = 'free-model-aggregator-02/';

/** The public base URL of the provider the free models belong to. */
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
/** The env var an entrant's OpenRouter key is pushed under (kept out of the sandbox). */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  /** The provider the model belongs to, as the brief names it (`openrouter`). */
  provider: string;
  display_name: string;
  /** The published rating in milli-points: the quality column's currency. */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What one prompt needs: a model without it cannot serve the prompt. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt the client will send, as the brief lists it. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

/** The brief as this server reads it. `error` is set when a document could not be read. */
export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

/** One model in the catalog document. */
export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

/** One provider in the catalog document. */
export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** What `--list` prints and what the entry POSTs to /register: the same document, byte for byte. */
export interface CatalogReport {
  providers: CatalogProvider[];
}

/** What a model can do, from the brief's row (null: the brief did not say). */
export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** Every JSON object in `text` that carries a string `schema`, in the order they appear. */
function scanDocuments(text: string): Json[] {
  const found: Json[] = [];
  let searchFrom = 0;
  for (;;) {
    const openAt = text.indexOf('{', searchFrom);
    if (openAt === -1) return found;
    const closeAt = braceClose(text, openAt);
    searchFrom = openAt + 1;
    if (closeAt === -1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(openAt, closeAt + 1));
    } catch {
      continue;
    }
    if (isRecord(parsed) && typeof parsed.schema === 'string') found.push(parsed);
  }
}

/**
 * Where the object opened at `openAt` closes, or -1 when it never does.
 * Quoted braces do not count: the scan walks the text once, remembering
 * whether it is inside a string and whether the last character escaped it.
 */
function braceClose(text: string, openAt: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let at = openAt;
  while (at < text.length) {
    const ch = text[at];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return at;
    }
    at += 1;
  }
  return -1;
}

/** The value as a string, or '' when it is anything else. */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The value as a finite number, or null when it is anything else. */
function asCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The value as a boolean, or null when it is anything else. */
function asFlag(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * The first document under this contest's prefix that carries one of `keys` as
 * an array: the document and the key it was found under.
 */
function pickArray(docs: readonly Json[], keys: readonly string[]): { doc: Json; key: string } | null {
  const wanted = docs.filter((doc) => asText(doc.schema).includes(SCHEMA_PREFIX));
  for (const doc of wanted) {
    const key = keys.find((k) => Array.isArray(doc[k]));
    if (key !== undefined) return { doc, key };
  }
  return null;
}

/**
 * One model row. The id is the row's `id`, or its `model` under the provider
 * that names it: a row that gives the bare OpenRouter id (`vendor/model:free`)
 * and names `openrouter` is routed as the gateway spells it
 * (`openrouter/vendor/model:free`). A row is free unless it says `free: false`;
 * a paid row is never routed.
 */
function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const bare = asText(v.id) === '' ? asText(v.model) : asText(v.id);
  if (bare === '') return null;
  const who = asText(v.provider) === '' ? asText(v.wire) : asText(v.provider);
  const prefixed = who === 'openrouter' && !bare.toLowerCase().startsWith('openrouter/');
  const shown = asText(v.display_name) === '' ? bare : asText(v.display_name);
  return {
    id: prefixed ? `openrouter/${bare}` : bare,
    provider: who === '' ? 'openrouter' : who,
    display_name: shown,
    rating_milli: asCount(v.rating_milli) ?? 0,
    context_length: asCount(v.context_length),
    tools: asFlag(v.tools),
    vision: asFlag(v.vision),
    json: asFlag(v.json),
    free: v.free !== false,
  };
}

function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  const id = asText(v.id);
  if (id === '') return null;
  const wanted = isRecord(v.requires) ? v.requires : {};
  const requires: Requirement = {};
  if (wanted.tools === true) requires.tools = true;
  if (wanted.vision === true) requires.vision = true;
  if (wanted.json === true) requires.json = true;
  const floor = asCount(wanted.min_context);
  if (floor !== null) requires.min_context = floor;
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires,
  };
}

/** The brief at `path`, its two documents found under this contest's schema prefix. */
export function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = scanDocuments(text);
  const modelsDoc = pickArray(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  }
  const rows = modelsDoc.doc[modelsDoc.key] as unknown[];
  const models = rows.flatMap((v) => {
    const parsed = modelOf(v);
    return parsed === null ? [] : [parsed];
  });
  const promptsDoc = pickArray(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  }
  const entries = promptsDoc.doc[promptsDoc.key] as unknown[];
  const prompts = entries.flatMap((v) => {
    const parsed = promptOf(v);
    return parsed === null ? [] : [parsed];
  });
  return { models, prompts, error: null };
}

/** The models this entry may serve: the brief's free ones, in the brief's order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

/** What a model can do, as the brief's row says it. */
export function capabilitiesOf(model: ModelRow): Capabilities {
  return {
    context_length: model.context_length,
    tools: model.tools,
    vision: model.vision,
    json: model.json,
  };
}

/** Whether a model's capabilities meet one prompt's requirements. An unknown capability never meets one. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  const gates: [boolean, boolean][] = [
    [requires.tools === true, caps.tools === true],
    [requires.vision === true, caps.vision === true],
    [requires.json === true, caps.json === true],
  ];
  for (const [asked, held] of gates) if (asked && !held) return false;
  if (requires.min_context !== undefined) {
    if (caps.context_length === null || caps.context_length < requires.min_context) return false;
  }
  return true;
}

/**
 * The catalog the brief's free model list makes: one provider, the models it serves.
 *
 * The base_url is the provider's public endpoint, never the gateway's
 * trial-local address: the gateway's origin differs between a live pass and its
 * replay, and the catalog is part of the state export a replay must reproduce
 * byte for byte.
 *
 * This lists every free model in the brief — exactly the fourteen dialable ids
 * the catalog column scores — so keep it that way: register this set and keep
 * GET /v1/models (both auth headers) exactly that set, since listing fewer
 * loses the column as surely as listing more.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const byId = new Map<string, CatalogModel>();
  for (const model of brief.models) {
    if (!model.free || byId.has(model.id)) continue;
    byId.set(model.id, { id: model.id, free: true, context_length: model.context_length });
  }
  const models = [...byId.values()];
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
