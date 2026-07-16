//! In-memory rate limiter, sliding window. Used to cap login link requests
//! (`/v1/auth/request-link`) — cf. spec §7.2: "rate limiting on login".
//! Two abuses targeted: email bombardment (SMTP spam on behalf of the instance
//! → reputation/blacklist) and hammering from a single IP. No external
//! dependency or persistent state: the counter is rebuilt on restart, which is
//! acceptable for this defense (it throttles abuse, it does not store a secret).

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

/// Max number of tracked keys before sweeping expired entries: bounds memory
/// against an attacker rotating IPs/emails (cf. `SyncHub` eviction, same class
/// of problem).
const MAX_TRACKED_KEYS: usize = 50_000;

/// Sliding window per key. Cloneable (shares the same state via `Arc`), stored
/// in the `AppState`.
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<HashMap<String, VecDeque<i64>>>>,
    window_ms: i64,
    max: usize,
}

impl RateLimiter {
    /// `max` requests allowed per `window_ms` per key.
    pub fn new(window_ms: i64, max: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            window_ms,
            max,
        }
    }

    /// Records an attempt for `key` at instant `now` (epoch ms). Returns
    /// `true` if within quota, `false` if the key exceeded `max` over the
    /// window. Pure and synchronous (no `.await` under the lock).
    pub fn check(&self, key: &str, now: i64) -> bool {
        // Tolerant recovery from lock poisoning (a panic elsewhere must not
        // turn the limiter into a single point of failure — and `unwrap()`
        // is forbidden outside tests).
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let cutoff = now - self.window_ms;

        if map.len() > MAX_TRACKED_KEYS {
            map.retain(|_, hits| hits.back().is_some_and(|&t| t >= cutoff));
        }

        let hits = map.entry(key.to_string()).or_default();
        while hits.front().is_some_and(|&t| t < cutoff) {
            hits.pop_front();
        }
        if hits.len() >= self.max {
            return false;
        }
        hits.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_within_window() {
        let rl = RateLimiter::new(1000, 3);
        assert!(rl.check("k", 0));
        assert!(rl.check("k", 100));
        assert!(rl.check("k", 200));
        // 4th within the window → rejected.
        assert!(!rl.check("k", 300));
        // Another key is not affected.
        assert!(rl.check("other", 300));
    }

    #[test]
    fn recovers_after_window_slides() {
        let rl = RateLimiter::new(1000, 2);
        assert!(rl.check("k", 0));
        assert!(rl.check("k", 500));
        assert!(!rl.check("k", 600));
        // Past the window, old attempts are forgotten.
        assert!(rl.check("k", 1600));
    }
}
