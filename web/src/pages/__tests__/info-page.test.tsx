/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/preact";
import { InfoPage } from "../InfoPage";

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../components/ApiConfig", () => ({
  ApiConfig: () => <div data-testid="api-config">ApiConfig Mock</div>,
}));

vi.mock("../../components/ApiEndpoints", () => ({
  ApiEndpoints: () => <div data-testid="api-endpoints">ApiEndpoints Mock</div>,
}));

vi.mock("../../components/TestConnection", () => ({
  TestConnection: () => <div data-testid="test-connection">TestConnection Mock</div>,
}));

afterEach(() => {
  cleanup();
});

describe("InfoPage", () => {
  it("renders API configuration, endpoint tests, and connection diagnostics", () => {
    render(
      <InfoPage
        baseUrl="http://127.0.0.1:8080"
        apiKey="test-key"
        models={["gpt-5.4"]}
        selectedModel="gpt-5.4"
        onModelChange={() => {}}
        modelFamilies={[]}
        selectedEffort="medium"
        onEffortChange={() => {}}
        selectedSpeed={null}
        onSpeedChange={() => {}}
      />
    );

    expect(screen.getByTestId("api-config")).not.toBeNull();
    expect(screen.getByTestId("api-endpoints")).not.toBeNull();
    expect(screen.getByTestId("test-connection")).not.toBeNull();
  });
});
