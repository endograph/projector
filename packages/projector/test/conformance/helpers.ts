import {
  createCharter,
  type Charter,
  type ExecutorRunRequest,
  type ExecutorRunResult,
  type Frame,
  type MachineRun,
} from "../../index.ts";

export function charter(overrides: Partial<Charter> = {}): Charter {
  return createCharter({
    executor: { run: () => ({ completionReason: "done" as const }) },
    nodes: {},
    tools: {},
    commands: {},
    states: {},
    projections: {},
    ...overrides,
  });
}

export function createRecordingExecutor(
  run: (request: ExecutorRunRequest) => ExecutorRunResult | Promise<ExecutorRunResult> = () => ({
    completionReason: "done",
  }),
): {
  executor: Charter["executor"];
  requests: ExecutorRunRequest[];
} {
  const requests: ExecutorRunRequest[] = [];
  return {
    requests,
    executor: {
      run: async (request) => {
        requests.push(request);
        return await run(request);
      },
    },
  };
}

export async function drain(run: MachineRun): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of run) {
    frames.push(frame);
  }
  return frames;
}

export function requestForRuntime(
  requests: readonly ExecutorRunRequest[],
  runtimeInstanceId: string,
): ExecutorRunRequest {
  const request = requests.find((item) => item.runtimeInstanceId === runtimeInstanceId);
  if (!request) {
    throw new Error(`No executor request for runtime "${runtimeInstanceId}"`);
  }
  return request;
}

export function toolByNameLastWins(
  request: ExecutorRunRequest,
): Map<string, ExecutorRunRequest["inference"]["tools"][number]> {
  return new Map(request.inference.tools.map((tool) => [tool.name, tool]));
}
