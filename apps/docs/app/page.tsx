import { DocsShell } from "@/components/DocsShell";
import { HomePage } from "@/components/HomePage";
import { getNavigation } from "@/lib/content";

export default async function HomeRoute() {
  const navigation = await getNavigation();

  return (
    <DocsShell currentUrl="/" navigation={navigation}>
      <HomePage />
    </DocsShell>
  );
}
