/**
 * @assrt-ai/assrt — AI-powered QA testing SDK.
 *
 * Public API for programmatic usage of the Assrt testing engine.
 */

export { TestAgent } from "./core/agent";
export { McpBrowserManager } from "./core/browser";
export type { McpToolResult, McpTool } from "./core/browser";
export type {
  TestStep,
  TestAssertion,
  ScenarioResult,
  TestReport,
  SSEEventType,
} from "./core/types";
export { getCredential } from "./core/keychain";
export { trackEvent, shutdownTelemetry } from "./core/telemetry";
export { createTestVm, destroyTestVm, isFreestyleConfigured } from "./core/freestyle";
export type { FreestyleVm } from "./core/freestyle";
