/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as actors from "../actors.js";
import type * as agent from "../agent.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as convexJson from "../convexJson.js";
import type * as dev_access from "../dev/access.js";
import type * as dev_artifacts from "../dev/artifacts.js";
import type * as dev_prompts from "../dev/prompts.js";
import type * as dev_sessions from "../dev/sessions.js";
import type * as executorConfig from "../executorConfig.js";
import type * as frameHistory from "../frameHistory.js";
import type * as http from "../http.js";
import type * as messageActor from "../messageActor.js";
import type * as messages from "../messages.js";
import type * as sessionParticipants from "../sessionParticipants.js";
import type * as sessions from "../sessions.js";
import type * as topics from "../topics.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  actors: typeof actors;
  agent: typeof agent;
  artifacts: typeof artifacts;
  auth: typeof auth;
  convexJson: typeof convexJson;
  "dev/access": typeof dev_access;
  "dev/artifacts": typeof dev_artifacts;
  "dev/prompts": typeof dev_prompts;
  "dev/sessions": typeof dev_sessions;
  executorConfig: typeof executorConfig;
  frameHistory: typeof frameHistory;
  http: typeof http;
  messageActor: typeof messageActor;
  messages: typeof messages;
  sessionParticipants: typeof sessionParticipants;
  sessions: typeof sessions;
  topics: typeof topics;
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

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
