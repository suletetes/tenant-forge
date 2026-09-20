import { Redis } from "ioredis";

/**
 * Atomic token-bucket rate limiter (R12.2, design §6.1). The refill + check + decrement runs as a
 * SINGLE Lua script on Redis so the limit holds across all Fargate tasks — no per-instance
 * over-count (R12.5).
 *
 * KEYS[1] = bucket key (e.g. ratelimit:{tenantId} or ratelimit:ip:{ip}:{routeclass})
 * ARGV[1] = capacity      (bucket size)
 * ARGV[2] = refill_rate   (tokens per second)
 * ARGV[3] = now_ms        (server clock, ms)
 * ARGV[4] = requested     (tokens to consume, usually 1)
 * RETURNS { allowed(0|1), remaining(int), retry_after_ms(int) }
 */
export const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refill    = tonumber(ARGV[2])
local now_ms    = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local data   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts     = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now_ms
end

-- Refill based on elapsed time, capped at capacity.
local elapsed = math.max(0, now_ms - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry_after_ms = 0
if tokens >= requested then
  allowed = 1
  tokens = tokens - requested
else
  local deficit = requested - tokens
  retry_after_ms = math.ceil((deficit / refill) * 1000)
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
-- Expire idle buckets after enough time to fully refill (+ margin).
local ttl = math.ceil((capacity / refill) * 2) + 1
redis.call('EXPIRE', key, ttl)

return { allowed, math.floor(tokens), retry_after_ms }
`;

export interface BucketConfig {
  capacity: number;
  refillPerSec: number;
}

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterMs: number;
  resetMs: number; // ms until the bucket is full again
}

export class RateLimiter {
  private sha: string | null = null;

  constructor(private readonly redis: Redis) {}

  /** Loads the script once (SCRIPT LOAD); subsequent calls use EVALSHA. */
  private async ensureLoaded(): Promise<string> {
    if (!this.sha) this.sha = await this.redis.script("LOAD", TOKEN_BUCKET_LUA) as string;
    return this.sha;
  }

  async consume(key: string, cfg: BucketConfig, requested = 1): Promise<LimitResult> {
    const sha = await this.ensureLoaded();
    const now = Date.now();
    let raw: [number, number, number];
    try {
      raw = (await this.redis.evalsha(
        sha,
        1,
        key,
        String(cfg.capacity),
        String(cfg.refillPerSec),
        String(now),
        String(requested),
      )) as [number, number, number];
    } catch (err) {
      // NOSCRIPT after a Redis restart → reload and retry once.
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        this.sha = null;
        return this.consume(key, cfg, requested);
      }
      throw err;
    }
    const [allowed, remaining, retryAfterMs] = raw;
    return {
      allowed: allowed === 1,
      remaining,
      limit: cfg.capacity,
      retryAfterMs,
      resetMs: Math.ceil(((cfg.capacity - remaining) / cfg.refillPerSec) * 1000),
    };
  }
}
