// One constant-time equality for every secret compare in the service (shared
// secret header, webhook signature, PIN hash). Length is checked first so
// timingSafeEqual never throws, and an empty expected value never matches.

import { timingSafeEqual } from "node:crypto";

export function constantTimeEqual(expected: Buffer, candidate: Buffer): boolean {
  if (expected.length === 0 || expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}
