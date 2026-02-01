"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import cliSpinners from "cli-spinners";

interface ThinkingSpinnerProps {
  sessionId: Id<"sessions">;
}

export function ThinkingSpinner({ sessionId }: ThinkingSpinnerProps) {
  const processingState = useQuery(api.sessionEphemera.getProcessingState, {
    sessionId,
  });

  const [frameIndex, setFrameIndex] = useState(0);

  // Select a random spinner when processing starts
  const spinner = useMemo(() => {
    if (!processingState?.isProcessing) return null;

    const spinnerNames = Object.keys(cliSpinners) as (keyof typeof cliSpinners)[];
    const randomName = spinnerNames[Math.floor(Math.random() * spinnerNames.length)];
    return cliSpinners[randomName];
  }, [processingState?.processingStartedAt, processingState?.isProcessing]);

  // Animate the spinner
  useEffect(() => {
    if (!spinner || !processingState?.isProcessing) {
      setFrameIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % spinner.frames.length);
    }, spinner.interval);

    return () => clearInterval(interval);
  }, [spinner, processingState?.isProcessing]);

  if (!processingState?.isProcessing || !spinner) {
    return null;
  }

  return (
    <div className="text-terminal-green-dim">
      <span className="font-mono">{spinner.frames[frameIndex]}</span>
    </div>
  );
}
