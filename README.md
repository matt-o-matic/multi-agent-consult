# Multi-Agent Consult

Multi-Agent Consult is a local-first Next.js application for running structured multi-model collaboration sessions. You choose two participant models and one referee model, give them a shared task, and let them iterate until the referee decides they have converged or the turn cap is reached.

The current implementation is built around OpenRouter for model access, with web research and optional read-only workspace context. It is designed so direct provider adapters can be added later without rewriting the debate engine.

## What It Does

- Runs two participant models in parallel on the same task
- Lets the participants critique and revise each other across multiple turns
- Uses a configurable referee model to detect convergence and stop early
- Supports web research through Brave Search or provider-native search
- Supports optional read-only workspace tools for coding and document review
- Pauses the run when the referee needs clarification and asks the user structured multiple-choice questions
- Persists runs, turns, tool calls, sources, referee decisions, and final outputs in SQLite

## Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- Drizzle ORM
- SQLite via `better-sqlite3`
- OpenRouter for model access
- Brave Search for app-owned web search
- Vitest for tests

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Create your local env file:

```bash
cp .env.example .env.local
```

On PowerShell:

```powershell
Copy-Item .env.example .env.local
```

3. Set the required environment variables:

```bash
OPENROUTER_API_KEY=...
BRAVE_SEARCH_API_KEY=... # optional
```

4. Start the app:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

- `OPENROUTER_API_KEY`
  Required. Used for model catalog loading and all model completions.
- `BRAVE_SEARCH_API_KEY`
  Optional. Enables the app-owned Brave Search backend for the `web_search` tool.

If `BRAVE_SEARCH_API_KEY` is not set, the app can still run with `provider_native` search when the selected OpenRouter models support it.

The local SQLite database is created automatically under `data/` the first time the app starts.

## Development Commands

```bash
npm run dev
npm run lint
npm run build
npm run test
```

Database helpers:

```bash
npm run db:generate
npm run db:push
```

## Project Layout

```text
app/
  api/                  Route handlers for models, runs, SSE, and questions
  runs/[id]/            Run transcript page
components/             Builder and transcript UI
docs/                   Project plan and implementation log
lib/
  data/                 Persistence helpers
  db/                   SQLite schema and client
  providers/            Provider abstraction and OpenRouter adapter
  services/             Debate engine, tools, event bus, and run manager
tests/                  Unit tests for validation, tools, and orchestration
```

## How A Run Works

1. The user selects two participant models and one referee model.
2. Both participants generate initial proposals in parallel.
3. The referee evaluates both proposals in structured JSON.
4. If the drafts have converged, the run stops and the referee produces the final synthesis.
5. If not, the participants receive the opponent draft plus referee guidance and continue.
6. If missing information blocks the run, participants can propose user questions, but only the referee can issue a user-visible batch.
7. The final output is stored as `Solution`, `Rationale`, and `Sources`.

## Current Scope

- Local-first, single-user operation
- One active run at a time
- OpenRouter implemented as the only provider adapter
- Web search and read-only workspace tools only
- No mutating file tools, browser automation, or arbitrary shell access

## Known Limitations

- Active runs are process-local and do not automatically resume after a server restart
- Provider-native web search support depends on upstream OpenRouter model metadata
- Citations are attached as structured source blocks rather than inline provenance markers

## Notes For Contributors

- `docs/multi-agent-consult.plan.md` is the implementation plan
- `docs/multi-agent-consult.impl.md` is the running engineering log
- Local SQLite files live under `data/` and should not be committed
- Keep citations separate from the solution body unless the product direction changes
- Keep workspace tools read-only unless the repo explicitly expands that scope

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
