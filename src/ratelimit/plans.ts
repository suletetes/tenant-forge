import type { BucketConfig } from "./limiter";

/** Per-tenant plan buckets (R12.1). capacity = burst; refill = sustained rate/sec. */
export const PLAN_BUCKETS: Record<string, BucketConfig> = {
  free: { capacity: 60, refillPerSec: 1 }, // 60 req/min
  starter: { capacity: 300, refillPerSec: 5 }, // 300 req/min
  pro: { capacity: 1000, refillPerSec: 1000 / 60 }, // ~1000 req/min
};

export function bucketForPlan(plan: string): BucketConfig {
  return PLAN_BUCKETS[plan] ?? PLAN_BUCKETS.free!;
}

/** Pre-auth / IP buckets by route class (R23.1, R23.3). Credential routes are stricter. */
export const IP_BUCKETS: Record<"credential" | "general", BucketConfig> = {
  credential: { capacity: 10, refillPerSec: 10 / 60 }, // 10/min — blunts brute force
  general: { capacity: 30, refillPerSec: 30 / 60 }, // 30/min
};
