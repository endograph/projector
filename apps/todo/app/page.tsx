import { cookies } from "next/headers";
import { HomeClient } from "./HomeClient";
import type { Id } from "../convex/_generated/dataModel";

const SESSION_COOKIE_KEY = "sessionId";

export default async function Home() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE_KEY)?.value as Id<"sessions"> | undefined;

  return <HomeClient initialSessionId={sessionId ?? null} />;
}
