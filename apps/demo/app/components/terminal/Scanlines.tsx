"use client";

import { useAtom } from "jotai";
import { scanlinesEnabledAtom } from "@/src/atoms";

export function ScanlinesToggle() {
  const [enabled, setEnabled] = useAtom(scanlinesEnabledAtom);

  return (
    <button
      onClick={() => setEnabled(!enabled)}
      className="text-xs text-terminal-green-dim hover:text-terminal-green transition-colors"
    >
      [{enabled ? "x" : " "}] Scanlines
    </button>
  );
}
