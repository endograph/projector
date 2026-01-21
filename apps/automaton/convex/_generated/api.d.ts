/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as calendar from "../calendar.js";
import type * as chat from "../chat.js";
import type * as data from "../data.js";
import type * as goals from "../goals.js";
import type * as machineSteps from "../machineSteps.js";
import type * as machineTurns from "../machineTurns.js";
import type * as messages from "../messages.js";
import type * as progress from "../progress.js";
import type * as reminders from "../reminders.js";
import type * as sessions from "../sessions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  calendar: typeof calendar;
  chat: typeof chat;
  data: typeof data;
  goals: typeof goals;
  machineSteps: typeof machineSteps;
  machineTurns: typeof machineTurns;
  messages: typeof messages;
  progress: typeof progress;
  reminders: typeof reminders;
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
