import { AppearanceSettings } from "@/components/settings/appearance-client";
import {
  SettingsPage,
  SettingsPageHeader,
} from "@/components/settings/settings-section";

export default function AppearanceSettingsPage() {
  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Choose how Kestrel One looks in light and dark mode on this browser."
        eyebrow="Personal"
        title="Appearance"
      />
      <AppearanceSettings />
    </SettingsPage>
  );
}

