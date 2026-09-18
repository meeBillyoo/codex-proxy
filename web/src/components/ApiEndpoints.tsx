import { useCallback, useEffect, useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { ModelFamily } from "../../../shared/hooks/use-status";

type HttpMethod = "GET" | "POST";

interface ApiRequest {
  url: string;
  method: HttpMethod;
  body?: Record<string, unknown>;
}

interface ApiEndpoint {
  id: string;
  name: string;
  method: HttpMethod;
  path: string;
  buildRequest: (model: string) => ApiRequest;
}

interface ApiTestResult {
  model: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

interface EndpointTestState {
  running: boolean;
  results: ApiTestResult[];
}

interface ApiEndpointsProps {
  apiKey: string;
  defaultModel: string;
  modelFamilies: ModelFamily[];
}

const TEST_PROMPT = "Reply with OK only.";

function post(url: string, model: string, body: Record<string, unknown>): ApiRequest {
  return { url, method: "POST", body: { model, ...body } };
}

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    id: "chat-completions",
    name: "OpenAI Chat Completions",
    method: "POST",
    path: "/v1/chat/completions",
    buildRequest: (model) => post("/v1/chat/completions", model, {
      messages: [{ role: "user", content: TEST_PROMPT }],
      reasoning_effort: "low",
      max_completion_tokens: 8,
      stream: false,
    }),
  },
  {
    id: "responses",
    name: "OpenAI Responses",
    method: "POST",
    path: "/v1/responses",
    buildRequest: (model) => post("/v1/responses", model, {
      input: [{ role: "user", content: [{ type: "input_text", text: TEST_PROMPT }] }],
      reasoning: { effort: "low" },
    }),
  },
  {
    id: "responses-review",
    name: "Responses Review",
    method: "POST",
    path: "/v1/responses/review",
    buildRequest: (model) => post("/v1/responses/review", model, {
      input: [{ role: "user", content: [{ type: "input_text", text: TEST_PROMPT }] }],
      reasoning: { effort: "low" },
    }),
  },
  {
    id: "responses-compact",
    name: "Responses Compact",
    method: "POST",
    path: "/v1/responses/compact",
    buildRequest: (model) => post("/v1/responses/compact", model, {
      instructions: "Keep the conversation concise.",
      input: [{ role: "user", content: [{ type: "input_text", text: TEST_PROMPT }] }],
      reasoning: { effort: "low" },
    }),
  },
  {
    id: "anthropic-messages",
    name: "Anthropic Messages",
    method: "POST",
    path: "/v1/messages",
    buildRequest: (model) => post("/v1/messages", model, {
      messages: [{ role: "user", content: TEST_PROMPT }],
      max_tokens: 8,
      output_config: { effort: "low" },
      stream: false,
    }),
  },
  {
    id: "anthropic-count-tokens",
    name: "Anthropic Count Tokens",
    method: "POST",
    path: "/v1/messages/count_tokens",
    buildRequest: (model) => post("/v1/messages/count_tokens", model, {
      messages: [{ role: "user", content: TEST_PROMPT }],
    }),
  },
  {
    id: "gemini-generate",
    name: "Gemini generateContent",
    method: "POST",
    path: "/v1beta/models/:model:generateContent",
    buildRequest: (model) => ({
      url: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: "POST",
      body: {
        contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 1024 } },
      },
    }),
  },
  {
    id: "gemini-stream-generate",
    name: "Gemini streamGenerateContent",
    method: "POST",
    path: "/v1beta/models/:model:streamGenerateContent",
    buildRequest: (model) => ({
      url: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`,
      method: "POST",
      body: {
        contents: [{ role: "user", parts: [{ text: TEST_PROMPT }] }],
        generationConfig: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 1024 } },
      },
    }),
  },
  {
    id: "images",
    name: "OpenAI Images",
    method: "POST",
    path: "/v1/images/generations",
    buildRequest: (model) => post("/v1/images/generations", model, {
      prompt: "A single small black dot centered on a plain white background.",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    }),
  },
  {
    id: "models",
    name: "OpenAI Model List",
    method: "GET",
    path: "/v1/models",
    buildRequest: () => ({ url: "/v1/models", method: "GET" }),
  },
  {
    id: "model-catalog",
    name: "OpenAI Model Catalog",
    method: "GET",
    path: "/v1/models/catalog",
    buildRequest: () => ({ url: "/v1/models/catalog", method: "GET" }),
  },
  {
    id: "model-detail",
    name: "OpenAI Model Details",
    method: "GET",
    path: "/v1/models/:modelId",
    buildRequest: (model) => ({ url: `/v1/models/${encodeURIComponent(model)}`, method: "GET" }),
  },
  {
    id: "model-info",
    name: "Extended Model Info",
    method: "GET",
    path: "/v1/models/:modelId/info",
    buildRequest: (model) => ({ url: `/v1/models/${encodeURIComponent(model)}/info`, method: "GET" }),
  },
  {
    id: "gemini-models",
    name: "Gemini Model List",
    method: "GET",
    path: "/v1beta/models",
    buildRequest: () => ({ url: "/v1beta/models", method: "GET" }),
  },
];

function extractError(text: string, status: number): string {
  if (!text.trim()) return `HTTP ${status}`;
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (payload.error && typeof payload.error === "object") {
      const message = (payload.error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Plain-text and SSE errors are surfaced below.
  }
  return text.trim().slice(0, 240);
}

export function ApiEndpoints({ apiKey, defaultModel, modelFamilies }: ApiEndpointsProps) {
  const t = useT();
  const modelIds = modelFamilies.map((family) => family.id);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [testStates, setTestStates] = useState<Record<string, EndpointTestState>>({});

  useEffect(() => {
    setSelectedModels((current) => {
      const available = current.filter((model) => modelIds.includes(model));
      if (available.length > 0) return available;
      return defaultModel && modelIds.includes(defaultModel) ? [defaultModel] : modelIds.slice(0, 1);
    });
  }, [defaultModel, modelIds.join("\u0000")]);

  const testRequest = useCallback(async (endpoint: ApiEndpoint, model: string): Promise<ApiTestResult> => {
    const request = endpoint.buildRequest(model);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 120_000);
    const startedAt = performance.now();

    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (request.body) headers["Content-Type"] = "application/json";
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        model,
        ok: response.ok,
        status: response.status,
        latencyMs: Math.round(performance.now() - startedAt),
        error: response.ok ? null : extractError(text, response.status),
      };
    } catch (error) {
      return {
        model,
        ok: false,
        status: null,
        latencyMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, [apiKey]);

  const runTests = useCallback(async (endpoint: ApiEndpoint, targets: string[]) => {
    if (targets.length === 0) return;
    setTestStates((current) => ({
      ...current,
      [endpoint.id]: { running: true, results: [] },
    }));

    const results: ApiTestResult[] = [];
    for (const model of targets) {
      results.push(await testRequest(endpoint, model));
      setTestStates((current) => ({
        ...current,
        [endpoint.id]: { running: true, results: [...results] },
      }));
    }

    setTestStates((current) => ({
      ...current,
      [endpoint.id]: { running: false, results },
    }));
  }, [testRequest]);

  const toggleModel = (model: string) => {
    setSelectedModels((current) => (
      current.includes(model)
        ? current.filter((item) => item !== model)
        : [...current, model]
    ));
  };

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors overflow-hidden">
      <div class="p-5 border-b border-slate-100 dark:border-border-dark">
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25M6.75 17.25 1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
          </svg>
          <h2 class="text-[0.95rem] font-bold">{t("apiEndpoints")}</h2>
        </div>
        <p class="mt-1.5 text-xs text-slate-500 dark:text-text-dim">{t("apiEndpointsDesc")}</p>

        <div class="mt-4 rounded-lg border border-slate-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-3">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div>
              <p class="text-xs font-semibold text-slate-700 dark:text-text-main">{t("testModels")}</p>
              <p class="text-[0.68rem] text-slate-400 dark:text-text-dim mt-0.5">{t("testModelsHint")}</p>
            </div>
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedModels(modelIds)}
                class="px-2.5 py-1 text-[0.7rem] font-semibold rounded-md border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50 hover:text-primary transition-colors"
              >
                {t("selectAll")}
              </button>
              <button
                type="button"
                onClick={() => setSelectedModels([])}
                class="px-2.5 py-1 text-[0.7rem] font-semibold rounded-md border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50 hover:text-primary transition-colors"
              >
                {t("deselectAll")}
              </button>
            </div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            {modelFamilies.map((family) => {
              const selected = selectedModels.includes(family.id);
              return (
                <button
                  key={family.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleModel(family.id)}
                  class={`px-2.5 py-1 text-[0.7rem] font-semibold rounded-full border transition-colors ${
                    selected
                      ? "bg-primary-container border-primary/40 text-primary"
                      : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-dim hover:border-primary/40"
                  }`}
                >
                  {family.displayName || family.id}
                </button>
              );
            })}
            {modelFamilies.length === 0 && (
              <span class="text-xs text-slate-400 dark:text-text-dim">{t("noTestModels")}</span>
            )}
          </div>
        </div>
      </div>

      <div class="divide-y divide-slate-100 dark:divide-border-dark">
        {API_ENDPOINTS.map((endpoint) => {
          const state = testStates[endpoint.id];
          return (
            <div key={endpoint.id} class="p-4 sm:px-5">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class={`shrink-0 rounded px-1.5 py-0.5 text-[0.62rem] font-bold ${
                      endpoint.method === "GET"
                        ? "bg-info-container text-info"
                        : "bg-primary-container text-primary"
                    }`}>
                      {endpoint.method}
                    </span>
                    <span class="text-sm font-semibold text-slate-700 dark:text-text-main">{endpoint.name}</span>
                  </div>
                  <code class="mt-1 block truncate text-[0.72rem] text-slate-500 dark:text-text-dim selectable" title={endpoint.path}>
                    {endpoint.path}
                  </code>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={state?.running || !defaultModel}
                    onClick={() => void runTests(endpoint, [defaultModel])}
                    class="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-main hover:border-primary/50 hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {state?.running ? t("testInProgress") : t("endpointTest")}
                  </button>
                  <button
                    type="button"
                    disabled={state?.running || selectedModels.length === 0}
                    onClick={() => void runTests(endpoint, selectedModels)}
                    class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary-action text-white hover:bg-primary-action-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {state?.running ? t("testInProgress") : t("multiModelTest")}
                  </button>
                </div>
              </div>

              {state && state.results.length > 0 && (
                <div class="mt-3" aria-label={t("apiTestResults")}>
                  <div class="flex flex-wrap gap-1.5">
                    {state.results.map((result) => (
                      <span
                        key={`${endpoint.id}-${result.model}`}
                        class={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[0.68rem] font-medium ${
                          result.ok
                            ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400"
                            : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
                        }`}
                      >
                        <span class="truncate">{result.model}</span>
                        <span>{result.ok ? t("apiTestPassed") : t("apiTestFailed")}</span>
                        <span class="opacity-70">{result.status ? `HTTP ${result.status}` : "—"} · {result.latencyMs}ms</span>
                      </span>
                    ))}
                  </div>
                  {state.results.some((result) => !result.ok && result.error) && (
                    <div class="mt-2 space-y-1">
                      {state.results.filter((result) => !result.ok && result.error).map((result) => (
                        <p key={`${endpoint.id}-${result.model}-error`} class="text-[0.7rem] text-red-600 dark:text-red-400 break-words selectable">
                          <span class="font-semibold">{result.model}:</span> {result.error}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
