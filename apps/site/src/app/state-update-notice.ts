type ValidationIssue = {
  message?: unknown;
  path?: unknown;
};

function structuredValidationMessage(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const issue = parsed.find(
      (candidate): candidate is ValidationIssue =>
        Boolean(candidate) && typeof candidate === "object" && "message" in candidate,
    );
    if (!issue || typeof issue.message !== "string") return undefined;
    const path = Array.isArray(issue.path)
      ? issue.path.filter((part) => typeof part === "string" || typeof part === "number").join(".")
      : "";
    return path ? `${path}: ${issue.message}` : issue.message;
  } catch {
    return undefined;
  }
}

export function formatStateUpdateRejection(error: unknown, input: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw
    .replace(/^\[CONVEX[^\]]*\]\s*/i, "")
    .replace(/^Uncaught (?:Convex)?Error:\s*/i, "");
  const message = structuredValidationMessage(cleaned)
    ?? cleaned
      .split("\n")
      .find((line) => line.trim() && !line.trim().startsWith("at "))
      ?.trim();
  const record = input && typeof input === "object"
    ? (input as { address?: unknown })
    : undefined;
  const address = record?.address;
  const target = typeof address === "string"
    ? address
    : address && typeof address === "object" && "stateKey" in address
      ? String((address as { stateKey: unknown }).stateKey)
      : undefined;
  const detail = message || "The value did not satisfy the target state schema.";
  return `${target ? `${target}: ` : ""}${detail}`.slice(0, 500);
}
