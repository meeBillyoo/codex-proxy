/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { ApiEndpoints } from "./ApiEndpoints";

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
}));

const modelFamilies = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    efforts: [{ reasoningEffort: "low", description: "Low" }],
    defaultEffort: "low",
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    efforts: [{ reasoningEffort: "low", description: "Low" }],
    defaultEffort: "low",
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ApiEndpoints", () => {
  it("tests an endpoint with the default model and low reasoning effort", async () => {
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    render(
      <ApiEndpoints
        apiKey="current-key"
        defaultModel="gpt-5.4"
        modelFamilies={modelFamilies}
      />,
    );

    fireEvent.click(screen.getAllByText("endpointTest")[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer current-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-5.4",
      reasoning_effort: "low",
    });
  });

  it("runs a multi-model test for every selected model", async () => {
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    render(
      <ApiEndpoints
        apiKey="current-key"
        defaultModel="gpt-5.4"
        modelFamilies={modelFamilies}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "GPT-5.5" }));
    fireEvent.click(screen.getAllByText("multiModelTest")[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const models = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model);
    expect(models).toEqual(["gpt-5.4", "gpt-5.5"]);
  });
});
