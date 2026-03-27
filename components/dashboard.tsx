"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

import type {
  NormalizedModel,
  ParticipantConfig,
  RunConfig,
  RunSummary,
  SearchBackend,
  WorkspaceManifest,
  WorkspaceMode,
} from "@/lib/types";

interface DashboardProps {
  initialRuns: RunSummary[];
}

type RoleField = "participantA" | "participantB" | "referee";

interface BuilderRoleSettings {
  modelId: string;
  persona: string;
}

interface BuilderFormState {
  taskPrompt: string;
  maxTurns: number;
  searchBackend: SearchBackend;
  workspaceMode: WorkspaceMode;
  workspacePath: string;
  participantA: BuilderRoleSettings;
  participantB: BuilderRoleSettings;
  referee: BuilderRoleSettings;
}

type BuilderLocalSettings = Omit<BuilderFormState, "taskPrompt">;

interface ModelCatalogState {
  configured: boolean;
  braveConfigured: boolean;
  errors: string[];
  loading: boolean;
  models: NormalizedModel[];
}

const LOCAL_SETTINGS_KEY = "multi-agent-consult.builder-settings.v1";

const MAX_TURN_OPTIONS = [1, 2, 3, 4, 5, 6];

const SEARCH_OPTIONS: Array<{
  value: SearchBackend;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "No search",
    description: "Fastest path. Keep the run grounded in prompt and workspace context only.",
  },
  {
    value: "provider_native",
    label: "Model-native search",
    description: "Uses upstream model web search when the participant models support it.",
  },
  {
    value: "brave",
    label: "Brave Search",
    description: "Uses the app-owned web tool so search behavior is stable across model vendors.",
  },
];

const WORKSPACE_OPTIONS: Array<{
  value: WorkspaceMode;
  label: string;
  description: string;
}> = [
  {
    value: "off",
    label: "No workspace",
    description: "Keep the run fully prompt-driven.",
  },
  {
    value: "path",
    label: "Read-only workspace",
    description: "Let participants inspect a local folder without writing to it.",
  },
];

const ROLE_META: Record<
  RoleField,
  {
    eyebrow: string;
    title: string;
    description: string;
    instructionsPlaceholder: string;
  }
> = {
  participantA: {
    eyebrow: "Participant A",
    title: "Initial draft and critique",
    description:
      "This model produces its own answer, critiques the opposing answer, and revises when the referee keeps the task open.",
    instructionsPlaceholder:
      "Optional role guidance for participant A. Tone, background, risk tolerance, or what to optimize for.",
  },
  participantB: {
    eyebrow: "Participant B",
    title: "Independent counterweight",
    description:
      "Use this model to bring a genuinely different perspective into the room, not a weaker copy of participant A.",
    instructionsPlaceholder:
      "Optional role guidance for participant B. This is useful for a different lens, writing taste, or decision style.",
  },
  referee: {
    eyebrow: "Referee",
    title: "Task planner and convergence judge",
    description:
      "The referee decomposes the prompt into tasks, watches the critique loop, and decides when each task has converged.",
    instructionsPlaceholder:
      "Optional role guidance for the referee. Keep it evaluative, selective, and meta instead of participatory.",
  },
};

function roleCompatibility(role: RoleField, model: NormalizedModel) {
  return role === "referee" ? model.supportsStructuredOutput : model.supportsTools;
}

function compactModelName(modelId: string) {
  const parts = modelId.split("/");
  return parts.at(-1) ?? modelId;
}

function formatModelLabel(model: NormalizedModel) {
  return model.name && model.name !== model.id ? `${model.name} • ${model.id}` : model.id;
}

function displaySelectedModelName(
  selectedModel: NormalizedModel | null,
  fallbackModelId: string,
) {
  return selectedModel?.name || fallbackModelId || "unset";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatContextLength(value?: number) {
  if (!value) {
    return null;
  }

  return `${value.toLocaleString()} ctx`;
}

function sanitizeRoleSettings(value: unknown): BuilderRoleSettings {
  if (!value || typeof value !== "object") {
    return { modelId: "", persona: "" };
  }

  const record = value as Record<string, unknown>;
  return {
    modelId: typeof record.modelId === "string" ? record.modelId : "",
    persona: typeof record.persona === "string" ? record.persona : "",
  };
}

function sanitizeSearchBackend(value: unknown, fallback: SearchBackend): SearchBackend {
  return value === "off" || value === "provider_native" || value === "brave"
    ? value
    : fallback;
}

function sanitizeWorkspaceMode(value: unknown, fallback: WorkspaceMode): WorkspaceMode {
  return value === "off" || value === "path" ? value : fallback;
}

function sanitizeTurnCount(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(6, Math.max(1, value));
}

function createDefaultFormState(latestRun?: RunSummary | null): BuilderFormState {
  return {
    taskPrompt: "",
    maxTurns: 3,
    searchBackend: "off",
    workspaceMode: "off",
    workspacePath: "",
    participantA: {
      modelId: latestRun?.participantA.modelId ?? "",
      persona: latestRun?.participantA.persona ?? "",
    },
    participantB: {
      modelId: latestRun?.participantB.modelId ?? "",
      persona: latestRun?.participantB.persona ?? "",
    },
    referee: {
      modelId: latestRun?.referee.modelId ?? "",
      persona: latestRun?.referee.persona ?? "",
    },
  };
}

function toLocalSettings(form: BuilderFormState): BuilderLocalSettings {
  return {
    maxTurns: form.maxTurns,
    searchBackend: form.searchBackend,
    workspaceMode: form.workspaceMode,
    workspacePath: form.workspacePath,
    participantA: form.participantA,
    participantB: form.participantB,
    referee: form.referee,
  };
}

function readStoredSettings(fallback: BuilderLocalSettings) {
  if (typeof window === "undefined") {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      maxTurns: sanitizeTurnCount(parsed.maxTurns, fallback.maxTurns),
      searchBackend: sanitizeSearchBackend(parsed.searchBackend, fallback.searchBackend),
      workspaceMode: sanitizeWorkspaceMode(parsed.workspaceMode, fallback.workspaceMode),
      workspacePath:
        typeof parsed.workspacePath === "string"
          ? parsed.workspacePath
          : fallback.workspacePath,
      participantA: sanitizeRoleSettings(parsed.participantA),
      participantB: sanitizeRoleSettings(parsed.participantB),
      referee: sanitizeRoleSettings(parsed.referee),
    } satisfies BuilderLocalSettings;
  } catch {
    return fallback;
  }
}

function mergeSettingsIntoForm(
  base: BuilderFormState,
  settings: BuilderLocalSettings,
): BuilderFormState {
  return {
    ...base,
    maxTurns: settings.maxTurns,
    searchBackend: settings.searchBackend,
    workspaceMode: settings.workspaceMode,
    workspacePath: settings.workspacePath,
    participantA: settings.participantA,
    participantB: settings.participantB,
    referee: settings.referee,
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter((value): value is string => value.length > 0))];
}

function getRecentModelIds(runs: RunSummary[], role: RoleField, currentId: string) {
  return uniqueStrings([currentId, ...runs.map((run) => run[role].modelId)]).slice(0, 6);
}

function sortCompatibleModels(
  models: NormalizedModel[],
  selectedId: string,
  quickPickIds: string[],
) {
  const selected = models.find((model) => model.id === selectedId);
  const quickPickSet = new Set(quickPickIds);
  const quickPicks = models.filter(
    (model) => model.id !== selectedId && quickPickSet.has(model.id),
  );
  const remainder = models.filter(
    (model) => model.id !== selectedId && !quickPickSet.has(model.id),
  );

  return [...(selected ? [selected] : []), ...quickPicks, ...remainder];
}

function filterModels(
  models: NormalizedModel[],
  filterText: string,
  selectedId: string,
) {
  const query = filterText.trim().toLowerCase();
  if (!query) {
    return models;
  }

  const filtered = models.filter((model) => {
    const haystack = [model.id, model.name, model.description]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });

  if (filtered.some((model) => model.id === selectedId)) {
    return filtered;
  }

  const selected = models.find((model) => model.id === selectedId);
  return selected ? [selected, ...filtered] : filtered;
}

function resolveModelId(
  requestedId: string,
  compatibleModels: NormalizedModel[],
  fallbacks: string[],
) {
  if (compatibleModels.some((model) => model.id === requestedId)) {
    return requestedId;
  }

  for (const fallbackId of fallbacks) {
    if (compatibleModels.some((model) => model.id === fallbackId)) {
      return fallbackId;
    }
  }

  return compatibleModels[0]?.id ?? "";
}

function resolveFormAgainstCatalog(
  form: BuilderFormState,
  models: NormalizedModel[],
  latestRun?: RunSummary | null,
) {
  const participantModels = models.filter((model) => roleCompatibility("participantA", model));
  const refereeModels = models.filter((model) => roleCompatibility("referee", model));

  return {
    ...form,
    participantA: {
      ...form.participantA,
      modelId: resolveModelId(form.participantA.modelId, participantModels, [
        latestRun?.participantA.modelId ?? "",
      ]),
    },
    participantB: {
      ...form.participantB,
      modelId: resolveModelId(form.participantB.modelId, participantModels, [
        latestRun?.participantB.modelId ?? "",
        form.participantA.modelId,
      ]),
    },
    referee: {
      ...form.referee,
      modelId: resolveModelId(form.referee.modelId, refereeModels, [
        latestRun?.referee.modelId ?? "",
      ]),
    },
  } satisfies BuilderFormState;
}

function buildRunPayload(form: BuilderFormState): RunConfig {
  function buildParticipant(
    role: ParticipantConfig["role"],
    label: string,
    settings: BuilderRoleSettings,
  ): ParticipantConfig {
    return {
      role,
      label,
      provider: "openrouter",
      modelId: settings.modelId,
      persona: settings.persona.trim() || undefined,
    };
  }

  return {
    taskPrompt: form.taskPrompt.trim(),
    maxTurns: form.maxTurns,
    searchBackend: form.searchBackend,
    workspaceMode: form.workspaceMode,
    workspacePath: form.workspaceMode === "path" ? form.workspacePath.trim() : null,
    participantA: buildParticipant("participant_a", "Participant A", form.participantA),
    participantB: buildParticipant("participant_b", "Participant B", form.participantB),
    referee: buildParticipant("referee", "Referee", form.referee),
  };
}

function ModelCapabilities({ model }: { model: NormalizedModel | null }) {
  if (!model) {
    return (
      <div className="rounded-[1.1rem] border border-dashed border-[var(--line)] px-4 py-4 text-sm text-[var(--ink-soft)]">
        Pick a model to see the capability profile.
      </div>
    );
  }

  const facts = [
    model.supportsTools ? "tools" : null,
    model.supportsStructuredOutput ? "structured JSON" : null,
    model.supportsProviderNativeSearch ? "native search" : null,
    formatContextLength(model.contextLength),
  ].filter((fact): fact is string => !!fact);

  return (
    <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/75 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-medium">{model.name}</div>
          <div className="mono mt-1 text-xs text-[var(--ink-soft)]">{model.id}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {facts.map((fact) => (
            <span key={fact} className="status-pill rounded-full px-3 py-1 text-xs">
              {fact}
            </span>
          ))}
        </div>
      </div>
      {model.description ? (
        <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">{model.description}</p>
      ) : null}
      {(model.pricing?.prompt || model.pricing?.completion || model.pricing?.webSearch) ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
          {model.pricing?.prompt ? <span>prompt {model.pricing.prompt}</span> : null}
          {model.pricing?.completion ? (
            <span>completion {model.pricing.completion}</span>
          ) : null}
          {model.pricing?.webSearch ? <span>search {model.pricing.webSearch}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function RoleEditorCard({
  filterText,
  matchingCount,
  model,
  onFilterChange,
  onModelChange,
  onPersonaChange,
  options,
  persona,
  quickPicks,
  role,
}: {
  filterText: string;
  matchingCount: number;
  model: NormalizedModel | null;
  onFilterChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onPersonaChange: (value: string) => void;
  options: NormalizedModel[];
  persona: string;
  quickPicks: NormalizedModel[];
  role: RoleField;
}) {
  const meta = ROLE_META[role];

  return (
    <article className="rounded-[1.7rem] border border-[var(--line)] bg-white/72 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">{meta.eyebrow}</p>
          <h3 className="mt-2 text-2xl font-semibold">{meta.title}</h3>
          <p className="mt-3 text-sm leading-7 text-[var(--ink-soft)]">
            {meta.description}
          </p>
        </div>
        {model ? (
          <span className="status-pill rounded-full px-4 py-2 text-sm">
            {compactModelName(model.id)}
          </span>
        ) : null}
      </div>

      <div className="mt-6 grid gap-5">
        <label className="grid gap-2">
          <span className="text-sm font-medium">Filter models</span>
          <input
            type="text"
            value={filterText}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter by model name, vendor, or id"
            className="w-full rounded-[1rem] border border-[var(--line)] bg-white/85 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
          />
          <span className="text-xs text-[var(--ink-soft)]">
            {matchingCount} compatible {matchingCount === 1 ? "model" : "models"} visible
          </span>
        </label>

        {quickPicks.length > 0 ? (
          <div className="grid gap-2">
            <span className="text-sm font-medium">Quick picks</span>
            <div className="flex flex-wrap gap-2">
              {quickPicks.map((quickPick) => (
                <button
                  key={quickPick.id}
                  type="button"
                  onClick={() => onModelChange(quickPick.id)}
                  className={
                    model?.id === quickPick.id
                      ? "rounded-full border border-[var(--accent)] bg-[rgba(196,106,45,0.12)] px-3 py-2 text-sm"
                      : "rounded-full border border-[var(--line)] bg-white/80 px-3 py-2 text-sm text-[var(--ink-soft)]"
                  }
                >
                  {compactModelName(quickPick.id)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <label className="grid gap-2">
          <span className="text-sm font-medium">Model</span>
          <select
            value={model?.id ?? ""}
            onChange={(event) => onModelChange(event.target.value)}
            className="w-full rounded-[1rem] border border-[var(--line)] bg-white/85 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
          >
            {options.length === 0 ? (
              <option value="">No compatible models found</option>
            ) : (
              options.map((option) => (
                <option key={option.id} value={option.id}>
                  {formatModelLabel(option)}
                </option>
              ))
            )}
          </select>
        </label>

        <ModelCapabilities model={model} />

        <label className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">Additional instructions</span>
            <span className="text-xs text-[var(--ink-soft)]">Saved locally</span>
          </div>
          <textarea
            value={persona}
            onChange={(event) => onPersonaChange(event.target.value)}
            placeholder={meta.instructionsPlaceholder}
            className="min-h-40 w-full rounded-[1rem] border border-[var(--line)] bg-white/85 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
          />
          <span className="text-xs leading-5 text-[var(--ink-soft)]">
            This text is appended to the role&apos;s system prompt. Keep it specific and durable.
          </span>
        </label>
      </div>
    </article>
  );
}

function RunHistoryCard({
  onReuseLineup,
  run,
}: {
  onReuseLineup: (run: RunSummary) => void;
  run: RunSummary;
}) {
  return (
    <article className="rounded-[1.4rem] border border-[var(--line)] bg-white/72 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="status-pill rounded-full px-3 py-1 text-xs">{run.status}</span>
            {run.stopReason ? (
              <span className="status-pill rounded-full px-3 py-1 text-xs">
                {run.stopReason}
              </span>
            ) : null}
          </div>
          <div className="text-sm text-[var(--ink-soft)]">{formatDateTime(run.createdAt)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/runs/${run.id}`}
            className="rounded-full border border-[var(--line)] px-3 py-2 text-sm"
          >
            Open
          </Link>
          <button
            type="button"
            onClick={() => onReuseLineup(run)}
            className="rounded-full bg-[var(--foreground)] px-3 py-2 text-sm text-[var(--background)]"
          >
            Reuse lineup
          </button>
        </div>
      </div>

      <p className="mt-4 max-h-24 overflow-hidden text-sm leading-6 text-[var(--foreground)]">
        {run.taskPrompt}
      </p>

      <div className="mt-4 grid gap-2 text-xs text-[var(--ink-soft)]">
        <div>{run.participantA.modelId}</div>
        <div>{run.participantB.modelId}</div>
        <div>{run.referee.modelId}</div>
      </div>
    </article>
  );
}

export function Dashboard({ initialRuns }: DashboardProps) {
  const router = useRouter();
  const latestRun = initialRuns[0] ?? null;
  const [runs, setRuns] = useState(initialRuns);
  const [form, setForm] = useState<BuilderFormState>(() => createDefaultFormState(latestRun));
  const [catalog, setCatalog] = useState<ModelCatalogState>({
    configured: false,
    braveConfigured: false,
    errors: [],
    loading: true,
    models: [],
  });
  const [modelFilters, setModelFilters] = useState<Record<RoleField, string>>({
    participantA: "",
    participantB: "",
    referee: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [workspaceManifest, setWorkspaceManifest] = useState<WorkspaceManifest | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<
    "idle" | "validating" | "valid" | "invalid"
  >("idle");
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localSettingsReady, setLocalSettingsReady] = useState(false);
  const [hasStoredSettings, setHasStoredSettings] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const deferredParticipantAFilter = useDeferredValue(modelFilters.participantA);
  const deferredParticipantBFilter = useDeferredValue(modelFilters.participantB);
  const deferredRefereeFilter = useDeferredValue(modelFilters.referee);

  useEffect(() => {
    const defaults = createDefaultFormState(latestRun);
    const persisted = readStoredSettings(toLocalSettings(defaults));
    const hasRawSettings = window.localStorage.getItem(LOCAL_SETTINGS_KEY) !== null;

    setForm((current) => ({
      ...mergeSettingsIntoForm(defaults, persisted),
      taskPrompt: current.taskPrompt,
    }));
    setHasStoredSettings(hasRawSettings);
    setLocalSettingsReady(true);
  }, [latestRun]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadModels() {
      try {
        const response = await fetch("/api/models", { signal: controller.signal });
        const payload = (await response.json()) as {
          braveConfigured?: boolean;
          configured?: boolean;
          errors?: string[];
          models?: NormalizedModel[];
        };

        if (controller.signal.aborted) {
          return;
        }

        setCatalog({
          configured: !!payload.configured,
          braveConfigured: !!payload.braveConfigured,
          errors: payload.errors ?? [],
          loading: false,
          models: payload.models ?? [],
        });
      } catch (loadError) {
        if (controller.signal.aborted) {
          return;
        }

        setCatalog({
          configured: false,
          braveConfigured: false,
          errors: [
            loadError instanceof Error ? loadError.message : "Could not load models.",
          ],
          loading: false,
          models: [],
        });
      }
    }

    void loadModels();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!localSettingsReady || catalog.models.length === 0) {
      return;
    }

    setForm((current) => resolveFormAgainstCatalog(current, catalog.models, latestRun));
  }, [catalog.models, latestRun, localSettingsReady]);

  const persistedLocalSettingsJson = useMemo(
    () => JSON.stringify(toLocalSettings(form)),
    [form],
  );

  useEffect(() => {
    if (!localSettingsReady) {
      return;
    }

    try {
      window.localStorage.setItem(LOCAL_SETTINGS_KEY, persistedLocalSettingsJson);
      setHasStoredSettings(true);
      setLastSavedAt(new Date().toISOString());
    } catch {
      // Ignore storage failures. The UI remains usable without local persistence.
    }
  }, [localSettingsReady, persistedLocalSettingsJson]);

  useEffect(() => {
    setWorkspaceManifest(null);
    setWorkspaceMessage(null);
    setWorkspaceStatus("idle");
  }, [form.workspaceMode, form.workspacePath]);

  const modelsById = useMemo(
    () => new Map(catalog.models.map((model) => [model.id, model])),
    [catalog.models],
  );

  const participantOptions = useMemo(
    () => catalog.models.filter((model) => roleCompatibility("participantA", model)),
    [catalog.models],
  );
  const refereeOptions = useMemo(
    () => catalog.models.filter((model) => roleCompatibility("referee", model)),
    [catalog.models],
  );

  const quickPickIds = useMemo(
    () => ({
      participantA: getRecentModelIds(runs, "participantA", form.participantA.modelId),
      participantB: getRecentModelIds(runs, "participantB", form.participantB.modelId),
      referee: getRecentModelIds(runs, "referee", form.referee.modelId),
    }),
    [form.participantA.modelId, form.participantB.modelId, form.referee.modelId, runs],
  );

  const participantAOptions = useMemo(
    () =>
      filterModels(
        sortCompatibleModels(
          participantOptions,
          form.participantA.modelId,
          quickPickIds.participantA,
        ),
        deferredParticipantAFilter,
        form.participantA.modelId,
      ),
    [
      deferredParticipantAFilter,
      form.participantA.modelId,
      participantOptions,
      quickPickIds.participantA,
    ],
  );
  const participantBOptions = useMemo(
    () =>
      filterModels(
        sortCompatibleModels(
          participantOptions,
          form.participantB.modelId,
          quickPickIds.participantB,
        ),
        deferredParticipantBFilter,
        form.participantB.modelId,
      ),
    [
      deferredParticipantBFilter,
      form.participantB.modelId,
      participantOptions,
      quickPickIds.participantB,
    ],
  );
  const refereeRoleOptions = useMemo(
    () =>
      filterModels(
        sortCompatibleModels(refereeOptions, form.referee.modelId, quickPickIds.referee),
        deferredRefereeFilter,
        form.referee.modelId,
      ),
    [deferredRefereeFilter, form.referee.modelId, quickPickIds.referee, refereeOptions],
  );

  const selectedModels = {
    participantA: modelsById.get(form.participantA.modelId) ?? null,
    participantB: modelsById.get(form.participantB.modelId) ?? null,
    referee: modelsById.get(form.referee.modelId) ?? null,
  };

  const activeRun = runs.find((run) =>
    ["queued", "running", "waiting_for_user"].includes(run.status),
  );

  const validationIssues = useMemo(() => {
    const issues: string[] = [];

    if (!catalog.loading && !catalog.configured) {
      issues.push("OpenRouter is not configured, so the model catalog is unavailable.");
    }
    if (!form.taskPrompt.trim()) {
      issues.push("Prompt is required.");
    }
    if (!form.participantA.modelId || !selectedModels.participantA) {
      issues.push("Participant A needs a compatible tool-calling model.");
    }
    if (!form.participantB.modelId || !selectedModels.participantB) {
      issues.push("Participant B needs a compatible tool-calling model.");
    }
    if (!form.referee.modelId || !selectedModels.referee) {
      issues.push("The referee needs a model that supports structured JSON output.");
    }
    if (
      form.searchBackend === "provider_native" &&
      (!selectedModels.participantA?.supportsProviderNativeSearch ||
        !selectedModels.participantB?.supportsProviderNativeSearch)
    ) {
      issues.push(
        "Provider-native search is enabled, but at least one participant model does not support it.",
      );
    }
    if (form.searchBackend === "brave" && !catalog.braveConfigured) {
      issues.push("Brave Search is selected, but BRAVE_SEARCH_API_KEY is not configured.");
    }
    if (form.workspaceMode === "path" && !form.workspacePath.trim()) {
      issues.push("Workspace mode is on, but no workspace path has been provided.");
    }
    if (activeRun) {
      issues.push("Only one active run is supported right now. Open the existing run or cancel it first.");
    }

    return issues;
  }, [
    activeRun,
    catalog.braveConfigured,
    catalog.configured,
    catalog.loading,
    form.participantA.modelId,
    form.participantB.modelId,
    form.referee.modelId,
    form.searchBackend,
    form.taskPrompt,
    form.workspaceMode,
    form.workspacePath,
    selectedModels.participantA,
    selectedModels.participantB,
    selectedModels.referee,
  ]);

  const quickPickModels = {
    participantA: quickPickIds.participantA
      .map((id) => modelsById.get(id) ?? null)
      .filter((model): model is NormalizedModel => !!model),
    participantB: quickPickIds.participantB
      .map((id) => modelsById.get(id) ?? null)
      .filter((model): model is NormalizedModel => !!model),
    referee: quickPickIds.referee
      .map((id) => modelsById.get(id) ?? null)
      .filter((model): model is NormalizedModel => !!model),
  };

  async function validateWorkspace() {
    if (form.workspaceMode !== "path") {
      setWorkspaceManifest(null);
      setWorkspaceMessage(null);
      setWorkspaceStatus("idle");
      return true;
    }

    const workspacePath = form.workspacePath.trim();
    if (!workspacePath) {
      setWorkspaceManifest(null);
      setWorkspaceMessage("Workspace path is required.");
      setWorkspaceStatus("invalid");
      return false;
    }

    setWorkspaceStatus("validating");
    setWorkspaceMessage(null);

    try {
      const response = await fetch("/api/workspaces/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workspacePath }),
      });
      const payload = (await response.json()) as {
        error?: string;
        manifest?: WorkspaceManifest;
      };

      if (!response.ok || !payload.manifest) {
        throw new Error(payload.error ?? "Workspace validation failed.");
      }

      setWorkspaceManifest(payload.manifest);
      setWorkspaceMessage("Workspace validated. Participants will get a read-only manifest.");
      setWorkspaceStatus("valid");
      return true;
    } catch (validationError) {
      setWorkspaceManifest(null);
      setWorkspaceMessage(
        validationError instanceof Error
          ? validationError.message
          : "Workspace validation failed.",
      );
      setWorkspaceStatus("invalid");
      return false;
    }
  }

  function updateRole(role: RoleField, patch: Partial<BuilderRoleSettings>) {
    setForm((current) => ({
      ...current,
      [role]: {
        ...current[role],
        ...patch,
      },
    }));
  }

  function reuseLineup(run: RunSummary) {
    setError(null);
    setForm((current) => ({
      ...current,
      participantA: {
        modelId: run.participantA.modelId,
        persona: run.participantA.persona ?? "",
      },
      participantB: {
        modelId: run.participantB.modelId,
        persona: run.participantB.persona ?? "",
      },
      referee: {
        modelId: run.referee.modelId,
        persona: run.referee.persona ?? "",
      },
    }));
  }

  function resetSavedSettings() {
    const defaults = createDefaultFormState(runs[0] ?? null);
    setError(null);

    try {
      window.localStorage.removeItem(LOCAL_SETTINGS_KEY);
    } catch {
      // Ignore localStorage failures.
    }

    setHasStoredSettings(false);
    setLastSavedAt(null);
    setForm((current) => ({
      ...resolveFormAgainstCatalog(defaults, catalog.models, runs[0] ?? null),
      taskPrompt: current.taskPrompt,
    }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (validationIssues.length > 0) {
      setError(validationIssues[0]);
      return;
    }

    setIsSubmitting(true);

    try {
      const workspaceIsValid = await validateWorkspace();
      if (!workspaceIsValid) {
        return;
      }

      const payload = buildRunPayload(form);
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        error?: string;
        run?: RunSummary & { id: string };
      };

      if (!response.ok || !result.run) {
        throw new Error(result.error ?? "Run creation failed.");
      }

      setRuns((current) => [
        result.run!,
        ...current.filter((run) => run.id !== result.run?.id),
      ]);
      router.push(`/runs/${result.run.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Run creation failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="app-shell grid-lines">
      <div className="flex w-full flex-1 flex-col gap-8 px-6 py-8 lg:px-10">
        <header className="panel panel-strong rounded-[2.2rem] px-7 py-8 md:px-10">
          <div className="grid gap-8 xl:grid-cols-[1.35fr_0.85fr]">
            <div>
              <p className="eyebrow">Builder</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-6xl">
                Set your lineup once, then keep shipping runs without rebuilding the room.
              </h1>
              <p className="mt-5 text-base leading-8 text-[var(--ink-soft)]">
                Model choices, search settings, workspace access, and role instructions are
                saved in this browser. Only the task prompt resets between runs.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <span className="status-pill rounded-full px-4 py-2 text-sm">
                  prompt stays local only for this draft
                </span>
                <span className="status-pill rounded-full px-4 py-2 text-sm">
                  {catalog.loading
                    ? "loading model catalog"
                    : `${catalog.models.length} models available`}
                </span>
                {activeRun ? (
                  <Link
                    href={`/runs/${activeRun.id}`}
                    className="rounded-full bg-[var(--foreground)] px-4 py-2 text-sm text-[var(--background)]"
                  >
                    Open active run
                  </Link>
                ) : null}
              </div>
            </div>

            <aside className="rounded-[1.8rem] border border-[var(--line)] bg-white/72 p-6">
              <p className="eyebrow">Local Settings</p>
              <div className="mt-4 space-y-4">
                <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 p-4">
                  <div className="text-sm font-medium">Persistence</div>
                  <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                    All builder configuration except the task prompt is stored in local settings.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
                    <span>stored: {hasStoredSettings ? "yes" : "not yet"}</span>
                    {lastSavedAt ? <span>last saved {formatDateTime(lastSavedAt)}</span> : null}
                  </div>
                </div>
                <div className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 p-4">
                  <div className="text-sm font-medium">Current lineup</div>
                  <div className="mt-3 space-y-2 text-sm leading-6 text-[var(--ink-soft)]">
                    <div>
                      A:{" "}
                      <span className="text-[var(--foreground)]">
                        {displaySelectedModelName(
                          selectedModels.participantA,
                          form.participantA.modelId,
                        )}
                      </span>
                    </div>
                    <div>
                      B:{" "}
                      <span className="text-[var(--foreground)]">
                        {displaySelectedModelName(
                          selectedModels.participantB,
                          form.participantB.modelId,
                        )}
                      </span>
                    </div>
                    <div>
                      Referee:{" "}
                      <span className="text-[var(--foreground)]">
                        {displaySelectedModelName(
                          selectedModels.referee,
                          form.referee.modelId,
                        )}
                      </span>
                    </div>
                    <div>
                      Search:{" "}
                      <span className="text-[var(--foreground)]">{form.searchBackend}</span>
                    </div>
                    <div>
                      Workspace:{" "}
                      <span className="text-[var(--foreground)]">
                        {form.workspaceMode === "path" && form.workspacePath
                          ? form.workspacePath
                          : "off"}
                      </span>
                    </div>
                    <div>
                      Turn cap:{" "}
                      <span className="text-[var(--foreground)]">{form.maxTurns}</span>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetSavedSettings}
                  className="w-full rounded-full border border-[var(--line)] px-4 py-3 text-sm"
                >
                  Reset saved settings
                </button>
              </div>
            </aside>
          </div>
        </header>

        <div className="grid gap-8 xl:grid-cols-[1.25fr_0.85fr]">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <section className="panel rounded-[2rem] p-7">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="eyebrow">Prompt</p>
                  <h2 className="mt-2 text-2xl font-semibold">Task for the participants</h2>
                </div>
                <span className="status-pill rounded-full px-4 py-2 text-sm">
                  not saved locally
                </span>
              </div>
              <label className="mt-5 grid gap-2">
                <span className="text-sm font-medium">Prompt</span>
                <textarea
                  value={form.taskPrompt}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, taskPrompt: event.target.value }))
                  }
                  placeholder="Describe the task, constraints, target audience, output format, and anything the referee should optimize for."
                  className="min-h-64 w-full rounded-[1.2rem] border border-[var(--line)] bg-white/80 px-5 py-4 outline-none transition focus:border-[var(--accent)]"
                />
                <span className="text-xs leading-5 text-[var(--ink-soft)]">
                  Prompt text stays ephemeral on purpose. Everything else below is sticky.
                </span>
              </label>
            </section>

            <section className="panel rounded-[2rem] p-7">
              <div>
                <p className="eyebrow">Run Setup</p>
                <h2 className="mt-2 text-2xl font-semibold">Core configuration</h2>
              </div>

              <div className="mt-6 grid gap-6">
                <div className="grid gap-3">
                  <span className="text-sm font-medium">Turn cap</span>
                  <div className="flex flex-wrap gap-2">
                    {MAX_TURN_OPTIONS.map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setForm((current) => ({ ...current, maxTurns: option }))}
                        className={
                          form.maxTurns === option
                            ? "rounded-full border border-[var(--accent)] bg-[rgba(196,106,45,0.12)] px-4 py-2 text-sm"
                            : "rounded-full border border-[var(--line)] bg-white/80 px-4 py-2 text-sm text-[var(--ink-soft)]"
                        }
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid gap-3">
                  <span className="text-sm font-medium">Web search</span>
                  <div className="grid gap-3 md:grid-cols-3">
                    {SEARCH_OPTIONS.map((option) => {
                      const disabled = option.value === "brave" && !catalog.braveConfigured;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            setForm((current) => ({ ...current, searchBackend: option.value }))
                          }
                          className={
                            form.searchBackend === option.value
                              ? "rounded-[1.3rem] border border-[var(--accent)] bg-[rgba(196,106,45,0.12)] p-4 text-left"
                              : "rounded-[1.3rem] border border-[var(--line)] bg-white/78 p-4 text-left disabled:opacity-50"
                          }
                        >
                          <div className="font-medium">{option.label}</div>
                          <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                            {option.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-3">
                  <span className="text-sm font-medium">Workspace access</span>
                  <div className="grid gap-3 md:grid-cols-2">
                    {WORKSPACE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() =>
                          setForm((current) => ({ ...current, workspaceMode: option.value }))
                        }
                        className={
                          form.workspaceMode === option.value
                            ? "rounded-[1.3rem] border border-[var(--accent)] bg-[rgba(196,106,45,0.12)] p-4 text-left"
                            : "rounded-[1.3rem] border border-[var(--line)] bg-white/78 p-4 text-left"
                        }
                      >
                        <div className="font-medium">{option.label}</div>
                        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                          {option.description}
                        </p>
                      </button>
                    ))}
                  </div>

                  {form.workspaceMode === "path" ? (
                    <div className="rounded-[1.4rem] border border-[var(--line)] bg-white/72 p-5">
                      <label className="grid gap-2">
                        <span className="text-sm font-medium">Workspace path</span>
                        <input
                          type="text"
                          value={form.workspacePath}
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              workspacePath: event.target.value,
                            }))
                          }
                          placeholder="D:\\Work\\repo or /Users/me/project"
                          className="w-full rounded-[1rem] border border-[var(--line)] bg-white/85 px-4 py-3 outline-none transition focus:border-[var(--accent)]"
                        />
                      </label>
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => void validateWorkspace()}
                          disabled={workspaceStatus === "validating"}
                          className="rounded-full border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50"
                        >
                          {workspaceStatus === "validating"
                            ? "Checking workspace..."
                            : "Validate workspace"}
                        </button>
                        {workspaceStatus === "valid" ? (
                          <span className="status-pill rounded-full px-3 py-1 text-xs">
                            validated
                          </span>
                        ) : null}
                        {workspaceStatus === "invalid" ? (
                          <span className="status-pill rounded-full px-3 py-1 text-xs">
                            invalid path
                          </span>
                        ) : null}
                      </div>
                      {workspaceMessage ? (
                        <p className="mt-4 text-sm leading-6 text-[var(--ink-soft)]">
                          {workspaceMessage}
                        </p>
                      ) : null}
                      {workspaceManifest ? (
                        <div className="mt-4 rounded-[1.2rem] border border-[var(--line)] bg-white/80 p-4">
                          <div className="text-sm font-medium">Workspace manifest</div>
                          <div className="mono mt-2 text-xs text-[var(--ink-soft)]">
                            {workspaceManifest.rootPath}
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {workspaceManifest.commands.map((command) => (
                              <span
                                key={command.id}
                                className="status-pill rounded-full px-3 py-1 text-xs"
                              >
                                {command.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="panel rounded-[2rem] p-7">
              <div>
                <p className="eyebrow">Roles</p>
                <h2 className="mt-2 text-2xl font-semibold">Model stack</h2>
                <p className="mt-3 text-sm leading-7 text-[var(--ink-soft)]">
                  Each role is full width on purpose. Large model catalogs are handled with
                  filtering and quick picks instead of cramming selects beside multi-line
                  textareas.
                </p>
              </div>

              <div className="mt-6 space-y-5">
                <RoleEditorCard
                  filterText={modelFilters.participantA}
                  matchingCount={participantAOptions.length}
                  model={selectedModels.participantA}
                  onFilterChange={(value) =>
                    setModelFilters((current) => ({ ...current, participantA: value }))
                  }
                  onModelChange={(value) => updateRole("participantA", { modelId: value })}
                  onPersonaChange={(value) => updateRole("participantA", { persona: value })}
                  options={participantAOptions}
                  persona={form.participantA.persona}
                  quickPicks={quickPickModels.participantA}
                  role="participantA"
                />
                <RoleEditorCard
                  filterText={modelFilters.participantB}
                  matchingCount={participantBOptions.length}
                  model={selectedModels.participantB}
                  onFilterChange={(value) =>
                    setModelFilters((current) => ({ ...current, participantB: value }))
                  }
                  onModelChange={(value) => updateRole("participantB", { modelId: value })}
                  onPersonaChange={(value) => updateRole("participantB", { persona: value })}
                  options={participantBOptions}
                  persona={form.participantB.persona}
                  quickPicks={quickPickModels.participantB}
                  role="participantB"
                />
                <RoleEditorCard
                  filterText={modelFilters.referee}
                  matchingCount={refereeRoleOptions.length}
                  model={selectedModels.referee}
                  onFilterChange={(value) =>
                    setModelFilters((current) => ({ ...current, referee: value }))
                  }
                  onModelChange={(value) => updateRole("referee", { modelId: value })}
                  onPersonaChange={(value) => updateRole("referee", { persona: value })}
                  options={refereeRoleOptions}
                  persona={form.referee.persona}
                  quickPicks={quickPickModels.referee}
                  role="referee"
                />
              </div>
            </section>

            {error ? (
              <div className="rounded-[1.5rem] border border-red-200 bg-red-50/80 px-5 py-4 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            <section className="panel rounded-[2rem] p-7">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="eyebrow">Launch</p>
                  <h2 className="mt-2 text-2xl font-semibold">Start the run</h2>
                  <p className="mt-3 text-sm leading-7 text-[var(--ink-soft)]">
                    One active run is supported right now, so the builder will block if
                    something is already in flight.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting || validationIssues.length > 0}
                  className="rounded-full bg-[var(--accent)] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {isSubmitting ? "Starting run..." : "Start consultation"}
                </button>
              </div>
            </section>
          </form>

          <aside className="space-y-6">
            <section className="panel rounded-[2rem] p-7">
              <div>
                <p className="eyebrow">Status</p>
                <h2 className="mt-2 text-2xl font-semibold">Preflight</h2>
              </div>

              {catalog.errors.length > 0 ? (
                <div className="mt-5 rounded-[1.3rem] border border-red-200 bg-red-50/80 p-4 text-sm text-red-700">
                  {catalog.errors.join(" ")}
                </div>
              ) : null}

              {validationIssues.length === 0 ? (
                <div className="mt-5 rounded-[1.3rem] border border-[var(--line)] bg-white/75 p-4 text-sm leading-7 text-[var(--ink-soft)]">
                  Builder looks clean. Model capabilities, search mode, and workspace settings
                  are aligned.
                </div>
              ) : (
                <div className="mt-5 space-y-3">
                  {validationIssues.map((issue) => (
                    <div
                      key={issue}
                      className="rounded-[1.2rem] border border-[var(--line)] bg-white/72 px-4 py-3 text-sm leading-6 text-[var(--ink-soft)]"
                    >
                      {issue}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel rounded-[2rem] p-7">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="eyebrow">Recent Runs</p>
                  <h2 className="mt-2 text-2xl font-semibold">
                    Jump back in or reuse a lineup
                  </h2>
                </div>
                <span className="status-pill rounded-full px-4 py-2 text-sm">
                  {runs.length} saved
                </span>
              </div>

              <div className="mt-5 space-y-4">
                {runs.length === 0 ? (
                  <div className="rounded-[1.4rem] border border-dashed border-[var(--line)] px-4 py-5 text-sm text-[var(--ink-soft)]">
                    No runs yet. Configure the builder once, then the next pass will be much
                    faster.
                  </div>
                ) : (
                  runs.slice(0, 8).map((run) => (
                    <RunHistoryCard key={run.id} onReuseLineup={reuseLineup} run={run} />
                  ))
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
