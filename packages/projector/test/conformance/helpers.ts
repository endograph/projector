import {
  createCharter,
  type Charter,
  type CharterConfig,
  type ExecutorRunRequest,
  type ExecutorRunResult,
  type Frame,
  type MachineRun,
  type ProjectorExecutor,
} from "../../index.ts";

export function charter(overrides: Partial<CharterConfig> = {}): Charter {
  return createCharter({
    nodes: [],
    tools: [],
    commands: [],
    states: [],
    ...overrides,
  });
}

export function noopExecutor(): ProjectorExecutor {
  return {
    run: () => ({ completionReason: "done" as const }),
    realizePrompt: (request) => ({ provider: "test", input: request.inference }),
  };
}

export function createRecordingExecutor(
  run: (request: ExecutorRunRequest) => ExecutorRunResult | Promise<ExecutorRunResult> = () => ({
    completionReason: "done",
  }),
): {
  executor: ProjectorExecutor;
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
      realizePrompt: (request) => ({ provider: "test", input: request.inference }),
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
  generatorId: string,
): ExecutorRunRequest {
  const request = requests.find((item) => item.generatorId === generatorId);
  if (!request) {
    throw new Error(`No executor request for runtime "${generatorId}"`);
  }
  return request;
}

export function toolByNameLastWins(
  request: ExecutorRunRequest,
): Map<string, ExecutorRunRequest["inference"]["tools"][number]> {
  return new Map(request.inference.tools.map((tool) => [tool.name, tool]));
}
