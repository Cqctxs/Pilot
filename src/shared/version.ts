import { VERSION_PATTERN } from "./pilot.js";

/** Compare the repository's strict three-part semantic versions numerically. */
export function compareVersions(left: string, right: string): number {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) {
    throw new Error(`Cannot compare invalid versions: ${left}, ${right}`);
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
