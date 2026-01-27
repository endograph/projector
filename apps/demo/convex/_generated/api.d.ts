/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as livekitAgent from "../livekitAgent.js";
import type * as livekitAgentActions from "../livekitAgentActions.js";
import type * as machineSteps from "../machineSteps.js";
import type * as machineTurns from "../machineTurns.js";
import type * as messages from "../messages.js";
import type * as sessionActions from "../sessionActions.js";
import type * as sessions from "../sessions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  livekitAgent: typeof livekitAgent;
  livekitAgentActions: typeof livekitAgentActions;
  machineSteps: typeof machineSteps;
  machineTurns: typeof machineTurns;
  messages: typeof messages;
  sessionActions: typeof sessionActions;
  sessions: typeof sessions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
