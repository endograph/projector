import { HomeClient } from "./HomeClient";

// Force dynamic rendering since we need Convex client
export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeClient initialSessionId={null} />;
}
