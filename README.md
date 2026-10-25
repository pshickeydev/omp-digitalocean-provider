# omp-digitalocean-provider

An [omp](https://github.com/can1357/oh-my-pi) extension that registers a
`do-inference` provider for [DigitalOcean Inference](https://docs.digitalocean.com/products/inference/)
(Serverless Inference). omp's built-in OpenAI-compatible discovery reads model
IDs and context limits — it does not know the per-token rates DigitalOcean
charges, and the DO API does not publish them. This extension bundles a cost
catalog (`do-models.json`) and cross-references it against the live model list
so each roster entry carries an accurate `cost` alongside `contextWindow`,
`maxTokens`, and capability flags.

## What it does

- Discovers models at runtime with `GET https://inference.do-ai.run/v1/models`
  (bearer-authenticated). The endpoint returns only `id`, `created`,
  `owned_by`, and `object` — **no pricing**.
- Attaches `cost: { input, output, cacheRead, cacheWrite }` (USD per 1,000,000
  tokens) from `do-models.json`, keyed by the exact model ID that
  `GET /v1/models` returns. These IDs differ from the docs' supported-models
  table: the live API uses dots in versions (`openai-gpt-5.4-nano`) and
  capitalizes some (`gemma-4-31B-it`, `mistral-3-14B`), so the catalog is keyed
  to the live endpoint, not the docs.
- Attaches `contextWindow`, `maxTokens`, `reasoning`, and `vision` from the
  same catalog. `vision` is advertised only where DO's usage notes explicitly
  list image/vision input.
- Lists a reasoning-effort ladder (`low | medium | high`) for reasoners whose
  effort is user-tunable (OpenAI, Anthropic, Kimi). DeepSeek, GLM, Arcee, and
  MiniMax reason by default and DO does not expose graded effort — they get
  `reasoning: true` but no ladder.
- Filters the catalog to models that are **currently live**. DO deprecates
  models; a deprecated model drops out of `/v1/models` and hence out of the
  omp roster, so stale entries do not linger.

## Install

Symlink the extension into omp's agent extensions directory:

```bash
ln -s "$(pwd)/do-inference-provider.ts" ~/.omp/agent/extensions/do-inference-provider.ts
```

omp follows the symlink and resolves the repository directory at runtime, so
`do-models.json` lives beside the source here — not in `~/.omp`.

## Configuration

Serverless Inference requires a bearer token for both the model list and chat
endpoints. Provide it with a DigitalOcean personal access token or a model
access key:

```bash
export DO_INFERENCE_API_KEY="doo_v1_..."   # or: DO_API_KEY
```

`DO_INFERENCE_API_KEY` takes precedence; `DO_API_KEY` is accepted as a
fallback. With no key set, the provider still registers so cost data is
visible, but it logs a warning that live availability is unconfirmed.

## How it works

1. `fetchDynamicModels` reads the live model list from `/v1/models`.
2. Every live model whose ID is in `do-models.json` is advertised with its
   bundled cost and capabilities. Models returned by DO but absent from the
   catalog are logged and omitted (the API may have started returning IDs in a
   different format — the warning lists the unpaired IDs).
3. Models in the catalog that are no longer live are simply not listed.
4. `cost` is passed through exactly as `do-models.json` publishes it.
   `cacheWrite` is nonzero only where DO publishes a write rate (Anthropic 5m
   tier, GPT-6.x, GPT-5.6); 0 means DO published none and is reported as-is —
   never derived.

## Limitations

- **Cost data is bundled and static.** DO publishes rates on its documentation
  pages, not behind an API, so `do-models.json` is a snapshot (read 2026-10-23)
  of the pricing pages, with keys verified against the live `GET /v1/models`
  list. Rebuild it when DO publishes new rates; the re-sync diff in
  [Verification](#verification) catches ID drift.
- **Cache-write rates are published-or-zero.** `cacheWrite` is set only where
  DO publishes a write rate; 0 means DO published none (most OpenAI models price
  cache writes at the standard input rate, which DO does not itemize). The
  provider never invents a rate.
- **Single-tier costs.** DO prices long context higher (Haiku 5.5 >100K, Sonnet
  4.5 >200K, and the GPT-6/5.6/5.5/5.4 families >272K cost roughly 2-5x) and
  offers Fast/Flex tiers. omp's cost shape has no per-tier field, so reported
  costs for long-context sessions understate actual spend.
- **Scheduled deprecations.** `anthropic-claude-4.5-sonnet` has a fixed
  end-of-support of Nov 30 2026; the live `/v1/models` cross-reference drops it
  from the roster automatically once DO retires it.
- **Output cap for unpublished models.** Where DO lists no max output tokens
  ("Not published"), the provider defaults to 32768 and never advertises more
  than the context window. DO clamps generations at the window anyway, so this
  is a ceiling, not a hard limit.
- **Reasoning models without a ladder.** DeepSeek, GLM, and Arcee reason by
  default and DO does not expose graded effort on them; they advertise
  `reasoning: true` without a `thinking` ladder, so thinking-off is not
  offered for them.
- **Model IDs must match the live API exactly.** Matching against
  `GET /v1/models` is case- and separator-sensitive; a catalog key that diverges
  (e.g. `openai-gpt-5-4` for the live `openai-gpt-5.4`, or `gemma-4-31b-it` for
  `gemma-4-31B-it`) is silently dropped as unmatched. Re-sync keys with the diff
  in [Verification](#verification).
- **Responses-API-only models use chat completions.** DO's docs flag some OpenAI
  models as "Responses API only," but the gateway answers `chat/completions` for
  them too (verified against the live API), so every model uses the single
  `openai-completions` transport.
- **Image/audio/video, TTS, and dedicated-only models** are excluded; the
  catalog covers serverless-capable text/chat models.

## Verification

- `omp models find do-inference` — roster with per-token costs on each model
- After editing `do-models.json` or when a model disappears, re-run
  `omp models refresh do-inference` (or restart omp).

Re-sync catalog keys against the live API after DO renames or retires models
(a non-empty `comm` output lists catalog keys that are stale or mis-cased):

```bash
curl -sS https://inference.do-ai.run/v1/models \
  -H "Authorization: Bearer $DO_INFERENCE_API_KEY" \
  | grep -oE '"id":"[^"]+"' | sed -E 's/"id":"//;s/"//g' | sort -u > /tmp/live.txt
node -e 'process.stdout.write(Object.keys(require("./do-models.json").models).join("\n")+"\n")' \
  | sort -u | comm -23 - /tmp/live.txt
```
