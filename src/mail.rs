//! Outgoing email for passwordless sign-in (magic-link) and sharing, via `lettre`.
//! If SMTP is not configured, the mailer runs in **dev mode**: instead of sending,
//! it logs the link so the developer can copy it from the console. Local signup
//! therefore works with zero email config; production sets the `SMTP_*` variables.
//!
//! Copy is localized to the recipient's account language (en/es/fr); English is
//! used as the fallback, including when the recipient has no account yet.

use lettre::message::MultiPart;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;
use crate::error::{Error, Result};

type Smtp = AsyncSmtpTransport<Tokio1Executor>;

/// Converts any send error (address, building, SMTP transport) into `Error::Mail`:
/// the lib exposes a typed error enum, `anyhow` stays confined to the binary.
fn mail_err<E: std::fmt::Display>(e: E) -> Error {
    Error::Mail(e.to_string())
}

const BRAND: &str = "Bramblekeep";
const ACCENT: &str = "#18181b";

/// Normalizes an arbitrary language tag to one we have copy for (English fallback).
fn lang_or_en(lang: &str) -> &str {
    match lang {
        "es" | "fr" => lang,
        _ => "en",
    }
}

/// Wraps localized body pieces in the shared email HTML shell (brand header,
/// paragraph, optional CTA button, footer note, optional raw-link line).
fn html_email(paragraph: &str, button: Option<(&str, &str)>, note: &str, link_line: Option<&str>) -> String {
    let button_html = button
        .map(|(label, href)| {
            format!(
                "<a href=\"{href}\" style=\"display:block;background:{ACCENT};color:#fff;text-decoration:none;\
                 text-align:center;font-weight:600;font-size:15px;padding:13px 0;border-radius:10px;margin-bottom:24px\">{label}</a>"
            )
        })
        .unwrap_or_default();
    let link_html = link_line
        .map(|l| {
            format!("<p style=\"color:#9ca3af;font-size:11px;margin:16px 0 0;word-break:break-all\">{l}</p>")
        })
        .unwrap_or_default();
    format!(
        "<!doctype html><html><body style=\"margin:0;background:#f6f7f9;\
         font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif\">\
         <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"padding:32px 12px\">\
         <tr><td align=\"center\"><table role=\"presentation\" width=\"440\" cellpadding=\"0\" cellspacing=\"0\" \
         style=\"max-width:440px;background:#fff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden\">\
         <tr><td style=\"padding:28px 32px\">\
         <div style=\"font-size:18px;font-weight:600;color:#111827;margin-bottom:16px\">{BRAND}</div>\
         <p style=\"color:#4b5563;font-size:15px;line-height:1.5;margin:0 0 24px\">{paragraph}</p>\
         {button_html}\
         <p style=\"color:#9ca3af;font-size:12px;margin:0\">{note}</p>\
         {link_html}\
         </td></tr></table></td></tr></table></body></html>"
    )
}

#[derive(Clone)]
pub struct Mailer {
    transport: Option<Smtp>,
    from: String,
    public_base_url: String,
}

impl Mailer {
    pub fn from_config(cfg: &Config) -> Self {
        let transport = cfg.smtp_host.as_ref().and_then(|host| {
            // 465 = implicit TLS; 587/25 = STARTTLS (plaintext then upgrade).
            let builder = if cfg.smtp_port == 465 {
                Smtp::relay(host).ok()?
            } else {
                Smtp::starttls_relay(host).ok()?
            };
            let mut builder = builder.port(cfg.smtp_port);
            if let (Some(u), Some(p)) = (&cfg.smtp_username, &cfg.smtp_password) {
                builder = builder.credentials(Credentials::new(u.clone(), p.clone()));
            }
            Some(builder.build())
        });
        if transport.is_none() {
            tracing::warn!("SMTP not configured — sign-in links are logged, not sent (dev mode)");
        }
        Mailer {
            transport,
            from: cfg.smtp_from.clone(),
            public_base_url: cfg.public_base_url.trim_end_matches('/').to_string(),
        }
    }

    /// Sends (or logs, in dev) a sign-in link to `to`, in `lang`.
    pub async fn send_login_link(&self, to: &str, token: &str, lang: &str) -> Result<()> {
        let link = format!("{}/auth/verify?token={}", self.public_base_url, token);
        if self.transport.is_none() {
            tracing::info!("[mail dev] sign-in link for {to}: {link}");
            return Ok(());
        }
        // (subject, intro paragraph, CTA label, footer note, raw-link label)
        let (subject, para, cta, note, link_lbl) = match lang_or_en(lang) {
            "es" => (
                format!("Tu enlace de acceso a {BRAND}"),
                "Haz clic para iniciar sesión. Sin contraseña.",
                "Iniciar sesión",
                "Este enlace caduca en 15 minutos. Si no lo solicitaste, ignora este correo.",
                "Enlace",
            ),
            "fr" => (
                format!("Votre lien de connexion {BRAND}"),
                "Cliquez pour vous connecter. Aucun mot de passe nécessaire.",
                "Se connecter",
                "Ce lien expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.",
                "Lien",
            ),
            _ => (
                format!("Your {BRAND} sign-in link"),
                "Click to sign in. No password needed.",
                "Sign in",
                "This link expires in 15 minutes. If you didn't request it, ignore this email.",
                "Link",
            ),
        };
        let plain = format!("{para}\n\n{link}\n\n{note}");
        let html = html_email(para, Some((cta, &link)), note, Some(&format!("{link_lbl}: {link}")));
        self.send(to, &subject, plain, html).await
    }

    /// Sends (or logs, in dev) an invitation to collaborate on a page, in `lang`.
    pub async fn send_invite(&self, to: &str, inviter: &str, page: &str, token: &str, lang: &str) -> Result<()> {
        let link = format!("{}/invite?token={}", self.public_base_url, token);
        if self.transport.is_none() {
            tracing::info!("[mail dev] invite for {to} on «{page}»: {link}");
            return Ok(());
        }
        let (subject, para, cta, note, link_lbl) = match lang_or_en(lang) {
            "es" => (
                format!("{inviter} te invitó a colaborar en {BRAND}"),
                format!("<strong>{inviter}</strong> te invitó a colaborar en «{page}»."),
                "Unirse a la página",
                "Crearás una cuenta si hace falta. Esta invitación caduca en 7 días. Si no la esperabas, ignora este correo.",
                "Enlace",
            ),
            "fr" => (
                format!("{inviter} vous invite à collaborer sur {BRAND}"),
                format!("<strong>{inviter}</strong> vous invite à collaborer sur « {page} »."),
                "Rejoindre la page",
                "Vous créerez un compte si besoin. Cette invitation expire dans 7 jours. Si vous ne l'attendiez pas, ignorez cet email.",
                "Lien",
            ),
            _ => (
                format!("{inviter} invited you to collaborate on {BRAND}"),
                format!("<strong>{inviter}</strong> invited you to collaborate on \"{page}\"."),
                "Join the page",
                "You'll create an account if needed. This invitation expires in 7 days. If you weren't expecting it, ignore this email.",
                "Link",
            ),
        };
        let plain = format!("{para}\n\n{link}\n\n{note}");
        let html = html_email(&para, Some((cta, &link)), note, Some(&format!("{link_lbl}: {link}")));
        self.send(to, &subject, plain, html).await
    }

    /// Notifies an EXISTING account that a page was just shared with it, in `lang`.
    pub async fn send_share_notification(
        &self,
        to: &str,
        inviter: &str,
        page: &str,
        item_id: &str,
        lang: &str,
    ) -> Result<()> {
        let link = format!("{}/p/{}", self.public_base_url, item_id);
        if self.transport.is_none() {
            tracing::info!("[mail dev] share of «{page}» with {to}: {link}");
            return Ok(());
        }
        let (subject, para, cta, note, link_lbl) = match lang_or_en(lang) {
            "es" => (
                format!("{inviter} compartió «{page}» contigo en {BRAND}"),
                format!("<strong>{inviter}</strong> compartió la página «{page}» contigo."),
                "Abrir la página",
                format!("También la encontrarás en tu lista de páginas en {BRAND}."),
                "Enlace",
            ),
            "fr" => (
                format!("{inviter} a partagé « {page} » avec vous sur {BRAND}"),
                format!("<strong>{inviter}</strong> a partagé la page « {page} » avec vous."),
                "Ouvrir la page",
                format!("Vous la retrouverez aussi dans votre liste de pages sur {BRAND}."),
                "Lien",
            ),
            _ => (
                format!("{inviter} shared \"{page}\" with you on {BRAND}"),
                format!("<strong>{inviter}</strong> shared the page \"{page}\" with you."),
                "Open the page",
                format!("You'll also find it in your page list on {BRAND}."),
                "Link",
            ),
        };
        let plain = format!("{para}\n\n{link}\n\n{note}");
        let html = html_email(&para, Some((cta, &link)), &note, Some(&format!("{link_lbl}: {link}")));
        self.send(to, &subject, plain, html).await
    }

    /// Tells a member that their invitation request (`target` on `page`) was
    /// approved or declined by an admin/owner, in `lang`.
    pub async fn send_invite_request_resolved(
        &self,
        to: &str,
        target: &str,
        page: &str,
        approved: bool,
        lang: &str,
    ) -> Result<()> {
        if self.transport.is_none() {
            let verdict = if approved { "approved" } else { "declined" };
            tracing::info!("[mail dev] invite request from {target} on «{page}» {verdict} → {to}");
            return Ok(());
        }
        let (subject, para, plain) = match lang_or_en(lang) {
            "es" => {
                let verdict = if approved { "aprobada" } else { "rechazada" };
                let detail = if approved {
                    format!("Se ha invitado a {target} a colaborar en «{page}».")
                } else {
                    format!("Tu solicitud de invitar a {target} en «{page}» no fue aceptada.")
                };
                (
                    format!("Tu solicitud de invitación fue {verdict} en {BRAND}"),
                    format!("Tu solicitud de invitación fue <strong>{verdict}</strong>. {detail}"),
                    format!("Tu solicitud de invitación fue {verdict} en {BRAND}.\n\n{detail}"),
                )
            }
            "fr" => {
                let verdict = if approved { "approuvée" } else { "refusée" };
                let detail = if approved {
                    format!("{target} a été invité(e) à collaborer sur « {page} ».")
                } else {
                    format!("Votre demande d'inviter {target} sur « {page} » n'a pas été retenue.")
                };
                (
                    format!("Votre demande d'invitation a été {verdict} sur {BRAND}"),
                    format!("Votre demande d'invitation a été <strong>{verdict}</strong>. {detail}"),
                    format!("Votre demande d'invitation a été {verdict} sur {BRAND}.\n\n{detail}"),
                )
            }
            _ => {
                let verdict = if approved { "approved" } else { "declined" };
                let detail = if approved {
                    format!("{target} has been invited to collaborate on \"{page}\".")
                } else {
                    format!("Your request to invite {target} on \"{page}\" was not accepted.")
                };
                (
                    format!("Your invitation request was {verdict} on {BRAND}"),
                    format!("Your invitation request was <strong>{verdict}</strong>. {detail}"),
                    format!("Your invitation request was {verdict} on {BRAND}.\n\n{detail}"),
                )
            }
        };
        let html = html_email(&para, None, "", None);
        self.send(to, &subject, plain, html).await
    }

    /// Builds and sends a multipart (plain + HTML) message.
    async fn send(&self, to: &str, subject: &str, plain: String, html: String) -> Result<()> {
        let Some(transport) = &self.transport else {
            return Ok(());
        };
        let email = Message::builder()
            .from(self.from.parse().map_err(mail_err)?)
            .to(to.parse().map_err(mail_err)?)
            .subject(subject)
            .multipart(MultiPart::alternative_plain_html(plain, html))
            .map_err(mail_err)?;
        transport.send(email).await.map_err(mail_err)?;
        Ok(())
    }
}
