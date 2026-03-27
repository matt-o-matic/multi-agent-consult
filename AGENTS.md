<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Repo Context

- This repository is `multi-agent-consult`, a local-first multi-model debate workbench.
- The product centers on two participant models, one referee model, structured convergence, web research, and optional read-only workspace context.
- OpenRouter is the only implemented provider today, but the provider abstraction is intentional and should remain extensible.

## Architecture Hotspots

- `lib/providers/openrouter.ts`: OpenRouter model catalog loading, capability normalization, completions, and source normalization.
- `lib/services/debate/coordinator.ts`: Core multi-turn orchestration, referee decisions, question pauses, and final synthesis.
- `lib/services/tool-broker.ts`: Participant tool surface, including web tools, workspace tools, and question proposals.
- `app/api/`: HTTP and SSE routes for runs, models, workspaces, and question-batch answers.
- `components/`: Builder, transcript, and referee question UI.

## Working Rules

- Keep citations separate from the solution body unless the product requirements change.
- Keep workspace access read-only unless the task explicitly expands the tool scope.
- Do not hardcode model lists; use the provider catalog and capability flags.
- Keep local artifacts out of the repo. Do not commit `.env*` files other than `.env.example`, and do not commit `data/`.
- When making meaningful implementation changes, update `docs/multi-agent-consult.impl.md`.
- Preserve the provider abstraction and do not collapse OpenRouter-specific logic into unrelated layers.
