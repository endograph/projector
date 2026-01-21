import { DevPanelContent } from "../../components/DevPanelContent";

type Screen = "overview" | "state" | "history" | "nodes" | "packs";

export default async function DevPage({
  params,
}: {
  params: Promise<{ screen: string }>;
}) {
  const { screen } = await params;
  const validScreen = ["overview", "state", "history", "nodes", "packs"].includes(screen)
    ? (screen as Screen)
    : "overview";

  return (
    <div className="min-h-screen bg-gray-100 p-8 dark:bg-gray-900">
      <div className="mx-auto max-w-4xl">
        <DevPanelContent screen={validScreen} isModal={false} />
      </div>
    </div>
  );
}
