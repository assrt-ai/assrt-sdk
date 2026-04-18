/**
 * Scenario store: capability-URL based scenario storage.
 *
 * Saves/loads test scenarios from a central API (assrt.ai) and caches locally
 * in ~/.assrt/scenarios/<uuid>.json for offline fallback.
 *
 * No auth required: the UUID v4 IS the access token.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CENTRAL_API_URL = process.env.ASSRT_API_URL || "https://app.assrt.ai";
const LOCAL_DIR = join(homedir(), ".assrt", "scenarios");

interface StoredScenario {
  id: string;
  plan: string;
  name?: string;
  url?: string;
  passCriteria?: string;
  variables?: Record<string, string>;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

function ensureLocalDir(): void {
  try {
    mkdirSync(LOCAL_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

function localPath(scenarioId: string): string {
  return join(LOCAL_DIR, `${scenarioId}.json`);
}

function writeLocal(scenario: StoredScenario): void {
  ensureLocalDir();
  try {
    writeFileSync(localPath(scenario.id), JSON.stringify(scenario, null, 2));
  } catch (err) {
    console.error("[scenario-store] Failed to write local cache:", (err as Error).message);
  }
}

function readLocal(scenarioId: string): StoredScenario | null {
  const path = localPath(scenarioId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Fetch a scenario from central storage by UUID.
 * Falls back to local cache if the central API is unreachable.
 */
export async function fetchScenario(scenarioId: string): Promise<StoredScenario | null> {
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/public/scenarios/${scenarioId}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as StoredScenario;
    const scenario: StoredScenario = {
      id: data.id,
      plan: data.plan,
      name: data.name,
      url: data.url,
      passCriteria: data.passCriteria,
      variables: data.variables,
      tags: data.tags,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
    writeLocal(scenario);
    return scenario;
  } catch (err) {
    console.error("[scenario-store] Central fetch failed, trying local cache:", (err as Error).message);
    return readLocal(scenarioId);
  }
}

/**
 * Save a new scenario to central storage. Returns the UUID.
 * Also caches locally.
 */
export async function saveScenario(data: {
  plan: string;
  name?: string;
  url?: string;
  passCriteria?: string;
  variables?: Record<string, string>;
  tags?: string[];
  createdFrom?: "mcp" | "webapp" | "cli";
}): Promise<string> {
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/public/scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${errBody}`);
    }
    const result = await res.json() as { id: string; createdAt?: string };
    writeLocal({ id: result.id, plan: data.plan, name: data.name, url: data.url, passCriteria: data.passCriteria, variables: data.variables, tags: data.tags, createdAt: result.createdAt });
    return result.id;
  } catch (err) {
    console.error("[scenario-store] Central save failed:", (err as Error).message);
    // Generate a local-only ID with a prefix so we know it's unsynced
    const crypto = await import("crypto");
    const localId = `local-${crypto.randomUUID()}`;
    writeLocal({ id: localId, plan: data.plan, name: data.name, url: data.url, passCriteria: data.passCriteria, variables: data.variables, tags: data.tags });
    return localId;
  }
}

/**
 * Update an existing scenario in central storage.
 */
export async function updateScenario(
  scenarioId: string,
  data: { plan?: string; name?: string; url?: string; passCriteria?: string; variables?: Record<string, string>; tags?: string[] }
): Promise<boolean> {
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/public/scenarios/${scenarioId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    // Update local cache
    const existing = readLocal(scenarioId);
    if (existing) {
      if (data.plan) existing.plan = data.plan;
      if (data.name) existing.name = data.name;
      if (data.url) existing.url = data.url;
      existing.updatedAt = new Date().toISOString();
      writeLocal(existing);
    }
    return true;
  } catch (err) {
    console.error("[scenario-store] Central update failed:", (err as Error).message);
    return false;
  }
}

/**
 * Save a run result to a scenario. Returns the run ID.
 */
export async function saveScenarioRun(
  scenarioId: string,
  data: {
    planSnapshot: string;
    url: string;
    model: string;
    status: "passed" | "failed" | "error";
    passedCount: number;
    failedCount: number;
    totalDuration: number;
    reportJson?: unknown;
    artifactUrls?: { video?: string; screenshots?: string[]; log?: string };
  }
): Promise<string | null> {
  try {
    const res = await fetch(`${CENTRAL_API_URL}/api/public/scenarios/${scenarioId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const result = await res.json() as { run?: { id?: string } };
      return result.run?.id || null;
    }
    return null;
  } catch (err) {
    console.error("[scenario-store] Failed to save run:", (err as Error).message);
    return null;
  }
}

/**
 * Upload artifact files (screenshots, video, log) to central storage.
 * Fire-and-forget: errors are logged but don't throw.
 */
export async function uploadArtifacts(
  scenarioId: string,
  runId: string,
  files: Array<{ name: string; path: string; type: string }>
): Promise<void> {
  const { readFileSync, existsSync } = await import("fs");

  const formData = new FormData();
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    try {
      const buffer = readFileSync(f.path);
      const blob = new Blob([buffer], { type: f.type });
      formData.append(f.name, blob, f.name);
    } catch (err) {
      console.error(`[scenario-store] Failed to read artifact ${f.name}:`, (err as Error).message);
    }
  }

  try {
    const res = await fetch(
      `${CENTRAL_API_URL}/api/public/scenarios/${scenarioId}/runs/${runId}/artifacts`,
      {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(120_000), // 2 min for large videos
      }
    );
    if (res.ok) {
      console.error(`[scenario-store] Uploaded ${files.length} artifact(s) for run ${runId.slice(0, 8)}...`);
    } else {
      console.error(`[scenario-store] Artifact upload failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[scenario-store] Artifact upload failed:", (err as Error).message);
  }
}

/**
 * Build deterministic cloud URLs for artifacts based on scenario ID and run ID.
 */
export function buildCloudUrls(
  scenarioId: string,
  runId: string,
  artifactNames: { video?: string; screenshots?: string[]; log?: string }
): {
  video?: string;
  screenshots?: string[];
  log?: string;
  page: string;
} {
  const base = `${CENTRAL_API_URL}/api/public/scenarios/${scenarioId}/runs/${runId}/artifacts`;
  const urls: ReturnType<typeof buildCloudUrls> = {
    page: `${CENTRAL_API_URL}/s/${scenarioId}`,
  };
  if (artifactNames.video) urls.video = `${base}?file=${artifactNames.video}`;
  if (artifactNames.log) urls.log = `${base}?file=${artifactNames.log}`;
  if (artifactNames.screenshots?.length) {
    urls.screenshots = artifactNames.screenshots.map((s) => `${base}?file=${s}`);
  }
  return urls;
}
