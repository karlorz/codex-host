import { realpath } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";

/** Resolve a workspace to its real path. Unresolved paths are denied. */
export async function canonicalizeWorkspace(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new DelegationControlError(
      "UNAUTHORIZED_TARGET",
      "Workspace must be an absolute path that can be resolved",
      { workspace: input },
    );
  }
  try {
    return await realpath(trimmed);
  } catch {
    throw new DelegationControlError("UNAUTHORIZED_TARGET", "Workspace could not be resolved", {
      workspace: input,
    });
  }
}

export async function canonicalizeWorkspaces(inputs: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const canonical = await canonicalizeWorkspace(input);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    resolved.push(canonical);
  }
  return resolved;
}

export function workspaceContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function workspaceAllowed(
  workspaces: readonly string[],
  candidate: string | undefined,
): boolean {
  if (!candidate) return false;
  return workspaces.some((root) => workspaceContains(root, candidate));
}
