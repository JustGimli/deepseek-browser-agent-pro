// src/rateLimiter.js — shared send throttle for one DeepSeek account across its tabs
'use strict';

/**
 * Token-bucket over a sliding log of timestamps. One instance is shared by the
 * main tab and every subagent tab of the SAME account, so N parallel tabs never
 * push that one account's total send rate past perSec / perMin combined.
 */
class RateLimiter {
  constructor({ perSec, perMin }) {
    this.perSec = perSec;
    this.perMin = perMin;
    this.hits   = []; // timestamps (ms) of sends granted so far
  }

  /** Resolves once a slot is free under both caps, then reserves it. */
  async take() {
    for (;;) {
      const now = Date.now();
      this.hits = this.hits.filter(t => now - t < 60_000);
      const inLastSec = this.hits.filter(t => now - t < 1_000);

      if (this.hits.length < this.perMin && inLastSec.length < this.perSec) {
        this.hits.push(now);
        return;
      }

      const blockedBySec = inLastSec.length >= this.perSec;
      const oldest       = blockedBySec ? inLastSec[0] : this.hits[0];
      const windowMs      = blockedBySec ? 1_000 : 60_000;
      await new Promise(r => setTimeout(r, Math.max(50, oldest + windowMs - now)));
    }
  }
}

module.exports = { RateLimiter };
