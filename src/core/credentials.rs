//! Credential validation: email address shape and password policy. Pure
//! functions (no I/O, no async), shared by every entry point that accepts
//! either — HTTP handlers, member invitation, and the `set-password` CLI.
//!
//! Deliberately NOT an RFC 5322 parser: that grammar accepts addresses no
//! mail server will ever route (comments, quoted local parts, IP literals) and
//! the regexes that approximate it are famously wrong. The goal here is
//! narrower and checkable: reject what cannot be delivered, so that the day an
//! instance switches from "sign-in links printed in the console" to a real SMTP
//! relay, no account holds a value like `admin` or `owner` that would make
//! `lettre` fail at send time.

/// Longest address we accept (RFC 5321 §4.5.3.1: 254 chars for a path).
const MAX_EMAIL: usize = 254;
/// Longest local part (before the `@`), same reference.
const MAX_LOCAL: usize = 64;

/// Shortest password we accept. Long enough that an offline attacker gains
/// nothing from a leaked argon2id hash, short enough to be typed daily.
pub const MIN_PASSWORD: usize = 12;
/// Longest password we accept. NOT a security cap — an argon2id call is
/// deliberately expensive, so an unbounded input is a CPU denial-of-service
/// handed to any anonymous caller of the login route.
pub const MAX_PASSWORD: usize = 128;

/// Characters allowed in a local part, beyond alphanumerics (RFC 5322 "atext",
/// minus what mail providers reject in practice).
const LOCAL_SPECIAL: &str = ".!#$%&'*+/=?^_`{|}~-";

/// Normalizes an address for storage and comparison: trimmed and lowercased.
/// Returns `None` when the address cannot be delivered to (see module docs).
///
/// Case folding the local part is technically wrong (RFC 5321 leaves it to the
/// receiving server) but universally done, and the alternative — two accounts
/// differing only by case — is worse for a self-hosted workspace.
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    if email.len() > MAX_EMAIL {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    // A second `@` lands in the domain, which rejects it below.
    if !local_is_valid(local) || !domain_is_valid(domain) {
        return None;
    }
    Some(email)
}

/// Is the address deliverable-looking? Convenience wrapper over
/// [`normalize_email`] for callers that already hold a normalized value.
pub fn email_is_valid(raw: &str) -> bool {
    normalize_email(raw).is_some()
}

fn local_is_valid(local: &str) -> bool {
    if local.is_empty() || local.len() > MAX_LOCAL {
        return false;
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    local
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || LOCAL_SPECIAL.contains(c))
}

fn domain_is_valid(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 255 || !domain.contains('.') {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    // A bare `example.` or `.example` yields an empty label.
    if labels.iter().any(|l| l.is_empty() || l.len() > 63) {
        return false;
    }
    if labels
        .iter()
        .any(|l| l.starts_with('-') || l.ends_with('-'))
    {
        return false;
    }
    if labels
        .iter()
        .any(|l| !l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
    {
        return false;
    }
    // TLD: letters only, at least two (rules out `user@host.1` and `user@localhost`,
    // neither of which a public relay will accept).
    let tld = labels[labels.len() - 1];
    tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())
}

/// Why a password was rejected. The caller turns this into a message; the
/// front-end shows the rule BEFORE submitting, so these are a safety net.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordIssue {
    TooShort,
    TooLong,
    Blank,
}

impl PasswordIssue {
    /// English fallback message (the front-end localizes from the error code).
    pub fn detail(self) -> String {
        match self {
            PasswordIssue::TooShort => {
                format!("password too short (minimum {MIN_PASSWORD} characters)")
            }
            PasswordIssue::TooLong => {
                format!("password too long (maximum {MAX_PASSWORD} characters)")
            }
            PasswordIssue::Blank => "password cannot be blank".to_string(),
        }
    }
}

/// Checks a password against the policy. Length is counted in characters, not
/// bytes: a passphrase in a non-latin script must not be penalised.
pub fn check_password(password: &str) -> Result<(), PasswordIssue> {
    if password.trim().is_empty() {
        return Err(PasswordIssue::Blank);
    }
    let chars = password.chars().count();
    if chars < MIN_PASSWORD {
        return Err(PasswordIssue::TooShort);
    }
    if chars > MAX_PASSWORD {
        return Err(PasswordIssue::TooLong);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_addresses() {
        for raw in [
            "matteo@example.com",
            "first.last@sub.example.co.uk",
            "user+tag@example.org",
            "a@b.io",
        ] {
            assert!(email_is_valid(raw), "{raw} should be valid");
        }
    }

    #[test]
    fn normalizes_case_and_spacing() {
        assert_eq!(
            normalize_email("  Matteo@Example.COM "),
            Some("matteo@example.com".to_string())
        );
    }

    #[test]
    fn rejects_a_username_that_is_not_an_address() {
        // The reported worry: these used to pass (`contains('@')` only) and
        // would blow up at SMTP send time.
        for raw in ["admin", "owner", "root", "matteo", ""] {
            assert!(!email_is_valid(raw), "{raw} should be rejected");
        }
    }

    #[test]
    fn rejects_undeliverable_shapes() {
        for raw in [
            "a@b",              // no dot in the domain
            "user@localhost",   // no TLD
            "user@host.1",      // numeric TLD
            "user@@example.com",
            "user@.example.com",
            "user@example..com",
            "user@-example.com",
            "user@example-.com",
            ".user@example.com",
            "user.@example.com",
            "us..er@example.com",
            "user name@example.com",
            "user@exa mple.com",
            "user@example.c",
        ] {
            assert!(!email_is_valid(raw), "{raw} should be rejected");
        }
    }

    #[test]
    fn rejects_oversized_addresses() {
        let long_local = "a".repeat(MAX_LOCAL + 1);
        assert!(!email_is_valid(&format!("{long_local}@example.com")));
        let long = format!("{}@example.com", "a".repeat(MAX_EMAIL));
        assert!(!email_is_valid(&long));
    }

    #[test]
    fn password_policy() {
        assert_eq!(check_password("correct horse battery"), Ok(()));
        assert_eq!(check_password("short"), Err(PasswordIssue::TooShort));
        assert_eq!(check_password("           "), Err(PasswordIssue::Blank));
        assert_eq!(
            check_password(&"a".repeat(MAX_PASSWORD + 1)),
            Err(PasswordIssue::TooLong)
        );
        // Exactly at the bounds: accepted.
        assert_eq!(check_password(&"a".repeat(MIN_PASSWORD)), Ok(()));
        assert_eq!(check_password(&"a".repeat(MAX_PASSWORD)), Ok(()));
    }

    #[test]
    fn password_length_counts_characters_not_bytes() {
        // 12 characters, 24 bytes in UTF-8: valid.
        assert_eq!(check_password("éèéèéèéèéèéè"), Ok(()));
    }
}
