import { GeneralSettings } from "./GeneralSettings";
import { LogsSettings } from "./LogsSettings";
import { ModelAliasSettings } from "./ModelAliasSettings";
import { QuotaSettings } from "./QuotaSettings";
interface SettingsTabProps { models: string[] }

export function SettingsTab(props: SettingsTabProps) {
  return (
    <div class="flex flex-col gap-6">
      <GeneralSettings />
      <ModelAliasSettings models={props.models} />
      <QuotaSettings />
      <LogsSettings />
    </div>
  );
}
