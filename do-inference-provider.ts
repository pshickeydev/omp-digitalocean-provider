// omp extension: DigitalOcean Serverless Inference provider with bundled costs.
//
// Registers a "do-inference" provider that lists DigitalOcean's cloud inference
// models (via the OpenAI-compatible `GET https://inference.do-ai.run/v1/models`)
// and attaches per-token pricing plus capability metadata that the DO API does
// not return. The `/v1/models` endpoint exposes only `id`, `created`,
// `owned_by` and `object`; DigitalOcean publishes rates on its docs pages, not
// behind an API. This extension therefore bundles a cost catalog
// (`do-models.json`) is keyed by the exact IDs GET /v1/models returns — NOT
// the docs' supported-models table, whose separators/case differ — cross-referenced
// deprecated models drop out of the roster.
//
// Install, configuration, and limitations: see README.md.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// DigitalOcean Serverless Inference host (the control-plane API lives at a
// different host). `registerProvider` below sets `baseUrl` to `${DO_BASE_URL}/v1`
// and omp appends `/chat/completions` to that, matching the working lemonade
// provider. Keep the trailing slash off `DO_BASE_URL` so no `//v1` path forms.
const DO_BASE_URL = "https://inference.do-ai.run";

// A bearer token is required for both the model-list and the chat endpoint.
// Prefer DO_INFERENCE_API_KEY (the serverless-inference naming), fall back to
// DO_API_KEY, and otherwise leave a placeholder so the provider still
// registers (costs remain visible) even before a key is configured.
const DO_API_KEY =
  (process.env.DO_INFERENCE_API_KEY ?? process.env.DO_API_KEY ?? "").trim() ||
  "DO_INFERENCE_API_KEY_PLACEHOLDER";

// Per-model output cap used when DO publishes none ("Not published" in the
// supported-models table). DO clamps generations at the model window itself, so
// a higher ceiling is harmless; 32768 is a conservative default that keeps
// short-output models from over-advertising while still letting the common
// text models serve. The provider re-fits every request to the window, so this
// never under-cuts a legitimate long generation beyond 32768 tokens.
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

interface DoModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface DoModelEntry {
  name: string;
  cost: DoModelCost;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision: boolean;
  // Whether to offer the effort ladder. Always-on or custom-effort reasoners
  // (DeepSeek, GLM) set this false; DO does not expose graded effort on them.
  thinking: boolean;
}

interface DoCatalog {
  models: Record<string, DoModelEntry>;
}

type ModelListResult =
  | { ok: true; ids: string[]; live: boolean }
  | { ok: false; error: string };

// Per /v1/models entry: `id` is the only field read unconditionally.
const isModelEntry = (value: unknown): value is { id: string } =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";

// Shared /v1/models read for discovery; never throws so the caller keeps its
// own logging surface. Requires a bearer token — without one DO returns 401.
async function fetchLiveModelIds(): Promise<ModelListResult> {
  if (DO_API_KEY === "DO_INFERENCE_API_KEY_PLACEHOLDER") {
    return {
      ok: false,
      error: `no DigitalOcean API key; set DO_INFERENCE_API_KEY (or DO_API_KEY). Showing the full bundled catalog without confirming live availability.`,
    };
  }
  try {
    const response = await fetch(`${DO_BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${DO_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, error: `/v1/models returned HTTP ${response.status}` };
    }
    const payload: unknown = await response.json();
    // Narrow with `in` (no inline cast): "data" narrows to unknown, Array.isArray
    // narrows to unknown[], then isModelEntry reads a checked `id` field.
    let entries: unknown[] = [];
    if (payload !== null && typeof payload === "object" && "data" in payload) {
      const data = payload.data;
      if (Array.isArray(data)) entries = data;
    }
    const ids = entries.filter(isModelEntry).map((m) => m.id);
    return { ok: true, ids, live: true };
  } catch (error: unknown) {
    return { ok: false, error: `cannot reach ${DO_BASE_URL}: ${String(error)}` };
  }
}
// `cost` is passed through exactly as the catalog publishes it. DO documents
// a cache-write rate only for a few families (Anthropic 5m tier, GPT-6.x, and
// the GPT-5.6 rows' "1.25x uncached input" note, all already explicit in the
// catalog). Where DO publishes no cache-write rate the catalog stores 0 and it
// stays 0 — the provider never derives a rate DO did not publish.

function resolveMaxTokens(entry: DoModelEntry): number {
  const published = entry.maxTokens;
  return published > 0 ? Math.min(published, entry.contextWindow) : Math.min(DEFAULT_MAX_OUTPUT_TOKENS, entry.contextWindow);
}

function mapModel(id: string, entry: DoModelEntry) {
  return {
    id,
    name: entry.name,
    api: "openai-completions" as const,
    reasoning: entry.reasoning,
    input: ["text" as const, ...(entry.vision ? (["image"] as const) : [])],
    cost: entry.cost,
    contextWindow: entry.contextWindow,
    maxTokens: resolveMaxTokens(entry),
    ...(entry.thinking
      ? {
          thinking: {
            mode: "effort" as const,
            efforts: ["low", "medium", "high"] as const,
            defaultLevel: "medium" as const,
          },
          compat: { reasoningDisableMode: "none-effort" as const },
        }
      : {}),
  };
}

export default function doInferenceProvider(pi: ExtensionAPI) {
  // do-models.json lives beside the real source file (realpath follows the
  // ~/.omp/agent/extensions install symlink), so the catalog stays in the repo
  // checkout rather than the symlink directory.
  const dir = realpathSync(dirname(fileURLToPath(import.meta.url)));

  let catalog: DoCatalog;
  try {
    catalog = JSON.parse(readFileSync(join(dir, "do-models.json"), "utf8")) as DoCatalog;
  } catch (error: unknown) {
    catalog = { models: {} };
    pi.logger?.error?.(`do-inference-provider: failed to read do-models.json: ${String(error)}`);
  }

  pi.registerProvider("do-inference", {
    baseUrl: `${DO_BASE_URL}/v1`,
    api: "openai-completions",
    apiKey: DO_API_KEY,
    fetchDynamicModels: async () => {
      const live = await fetchLiveModelIds();

      if (!live.ok) {
        // Discovery failed (no key, 401, network, malformed): still return the
        // full catalog so cost data is available, but flag that live
        // availability is unconfirmed.
        pi.logger?.warn?.(`do-inference-provider: ${live.error}`);
        return Object.entries(catalog.models).map(([id, entry]) => mapModel(id, entry));
      }

      const matched: string[] = [];
      const unmatched: string[] = [];
      const discovered = [...live.ids];

      for (const id of discovered) {
        const entry = catalog.models[id];
        if (entry) {
          matched.push(id);
        } else {
          unmatched.push(id);
        }
      }

      if (matched.length === 0 && discovered.length > 0) {
        // Discovered IDs that match no catalog entry: the live API is likely
        // returning IDs in a different format than the bundled catalog.
        pi.logger?.error?.(
          `do-inference-provider: /v1/models returned ${discovered.length} model(s) that match no catalog entry (IDs may differ from the bundled catalog). Unmatched: ${unmatched.join(", ")}.`,
        );
      } else if (unmatched.length > 0) {
        pi.logger?.warn?.(
          `do-inference-provider: ${unmatched.length} discovered model(s) have no catalog entry and will be omitted: ${unmatched.join(", ")}.`,
        );
      }

      if (matched.length === 0) {
        pi.logger?.warn?.("do-inference-provider: no live models matched the catalog; returning the full bundled catalog instead.");
        return Object.entries(catalog.models).map(([id, entry]) => mapModel(id, entry));
      }

      // Only advertise models that are both catalogued and currently live;
      // deprecated models drop out of /v1/models and hence out of the roster.
      return matched.map((id) => mapModel(id, catalog.models[id]));
    },
  });
}
