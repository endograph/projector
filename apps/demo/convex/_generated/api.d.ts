/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as attachments from "../attachments.js";
import type * as branching from "../branching.js";
import type * as convexJson from "../convexJson.js";
import type * as frameHistory from "../frameHistory.js";
import type * as frames from "../frames.js";
import type * as http from "../http.js";
import type * as livekitAgent from "../livekitAgent.js";
import type * as livekitAgentActions from "../livekitAgentActions.js";
import type * as messages from "../messages.js";
import type * as sessionActions from "../sessionActions.js";
import type * as sessionEphemera from "../sessionEphemera.js";
import type * as sessions from "../sessions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  attachments: typeof attachments;
  branching: typeof branching;
  convexJson: typeof convexJson;
  frameHistory: typeof frameHistory;
  frames: typeof frames;
  http: typeof http;
  livekitAgent: typeof livekitAgent;
  livekitAgentActions: typeof livekitAgentActions;
  messages: typeof messages;
  sessionActions: typeof sessionActions;
  sessionEphemera: typeof sessionEphemera;
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
