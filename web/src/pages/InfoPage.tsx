import { ApiConfig } from "../components/ApiConfig";
import { ApiEndpoints } from "../components/ApiEndpoints";
import { TestConnection } from "../components/TestConnection";
import type { ModelFamily } from "../../../shared/hooks/use-status";

interface InfoPageProps {
  baseUrl: string;
  apiKey: string;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  modelFamilies: ModelFamily[];
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
  selectedSpeed: string | null;
  onSpeedChange: (speed: string | null) => void;
}

export function InfoPage(props: InfoPageProps) {
  return (
    <div class="flex flex-col gap-6">
      <ApiConfig
        baseUrl={props.baseUrl}
        apiKey={props.apiKey}
        models={props.models}
        selectedModel={props.selectedModel}
        onModelChange={props.onModelChange}
        modelFamilies={props.modelFamilies}
        selectedEffort={props.selectedEffort}
        onEffortChange={props.onEffortChange}
        selectedSpeed={props.selectedSpeed}
        onSpeedChange={props.onSpeedChange}
      />
      <ApiEndpoints
        apiKey={props.apiKey}
        defaultModel={props.selectedModel}
        modelFamilies={props.modelFamilies}
      />
      <TestConnection />
    </div>
  );
}
