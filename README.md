# Live free-model aggregator

One server, two wires, a real free model behind every answer. Built for the
make.fun bounty `free-model-aggregator-02`.

- `POST /v1/chat/completions` — OpenAI wire, JSON and streaming
- `POST /v1/messages` — Anthropic wire, JSON and streaming
- `GET /v1/models` — the fourteen free OpenRouter models, in the shape of the
  auth header it got (`Authorization: Bearer` → OpenAI list, `x-api-key` →
  Anthropic list)

Every prompt is served by the highest-rated free model that meets its
requirements (JSON mode, tools, vision), dialled through the grader's gateway
on Chat Completions. A gateway 429 or 5xx fails over to the next-best model
that meets the prompt, and the refusals a retry recovered from are reported in
the `x-makefun-upstream-failures` header. `node main.ts --list` prints the
catalog document the server registers.

Run it in a trial with Node 22 and nothing installed:

```
node main.ts
```

`main.ts` is the entrypoint; `lib/providers.ts` reads the brief and builds
the catalog; `lib/wire.ts` translates the Anthropic wire both ways and keeps
every `model` field the id that was really dialled.
