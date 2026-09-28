import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const SITE = "https://mediscan.vaydena.de";
const PRICE_CENTS = 9900;
const MIN_FILL_MS = 3000;
const GLOBAL_PER_HOUR = 60;
const IP_PER_DAY = 10;
const AGB_VERSION = "2026-09";
const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|ru|cn|xyz|top|info|biz|io|de)\b\/?)/i;

class MissingTable extends Error {}

function clientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0] || req.headers.get("x-real-ip") || "").trim();
}
// Nur ein gesalzener Hash der IP wird gespeichert (keine Klar-IP).
async function hashIp(ip: string) {
  if (!ip) return "";
  const salt = Deno.env.get("IP_HASH_SALT") || Deno.env.get("SUPABASE_DB_URL") || "";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + ip));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function str(v: unknown, max?: number) { return (typeof v === "string" ? v : "").trim().slice(0, max || 500); }
function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] as string)); }
function euro(cents: number) { return ((Number(cents) || 0) / 100).toFixed(2).replace(".", ",") + " €"; }

function withTimeout<T>(p: Promise<T>, ms: number) {
  let t: number;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}
async function sendMail(to: string, subject: string, text: string, html: string) {
  const user = Deno.env.get("MAIL_USER");
  const pass = Deno.env.get("MAIL_PASSWORD");
  if (!user || !pass) return { ok: false, err: "mail_not_configured" };
  const host = Deno.env.get("MAIL_SMTP_HOST") || "smtp.hostinger.com";
  const port = Number(Deno.env.get("MAIL_SMTP_PORT") || "465");
  const from = Deno.env.get("MAIL_FROM") || user;
  let SMTPClient: any;
  try { ({ SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts")); }
  catch (e) { return { ok: false, err: "smtp_module:" + String((e && (e as Error).message) || e) }; }
  const client = new SMTPClient({ connection: { hostname: host, port, tls: true, auth: { username: user, password: pass } } });
  try {
    await withTimeout(client.send({ from: "MediScan <" + from + ">", to, subject, content: text, html }), 20000);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String((e && (e as Error).message) || e) };
  } finally {
    try { await withTimeout(client.close(), 5000); } catch (_e) { /* ignore */ }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  // Honeypot: still bestaetigen, aber nichts anlegen.
  if (str(body?.hp, 100)) return json({ ok: true, spam: true });
  // Mindest-Ausfuellzeit: Bots senden das Formular in Sekundenbruchteilen ab.
  const elapsed = Number(body?.elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return json({ error: "too_fast" }, 400);

  const buyer_name = str(body?.buyer_name, 120);
  if (buyer_name.length < 2) return json({ error: "bad_name" }, 400);
  if (URL_RE.test(buyer_name)) return json({ error: "bad_input" }, 400);
  const buyer_email = str(body?.buyer_email, 160).toLowerCase();
  if (!isEmail(buyer_email)) return json({ error: "bad_email" }, 400);
  if (body?.consent !== true) return json({ error: "consent_required" }, 400);
  if (body?.agb !== true) return json({ error: "agb_required" }, 400);
  const waiver = body?.waiver === true;

  const bill_recipient = str(body?.billing_recipient, 160) || buyer_name;
  const bill_street = str(body?.billing_street, 160);
  const bill_zip = str(body?.billing_zip, 20);
  const bill_city = str(body?.billing_city, 120);
  if ([bill_recipient, bill_street, bill_zip, bill_city].some((v) => URL_RE.test(v))) return json({ error: "bad_input" }, 400);
  const at = new Date().toISOString();
  const consents = { privacy: true, agb: true, waiver, at, agb_version: AGB_VERSION };
  const billing = { recipient: bill_recipient, street: bill_street, zip: bill_zip, city: bill_city, email: buyer_email, consents };
  const ip_hash = await hashIp(clientIp(req));

  let order_ref = "";
  let access_token = "";
  try {
    const res = await sql.begin(async (tx: any) => {
      // Serialisiert parallele Bestellungen, damit die Zaehlungen unten nicht umgangen werden koennen.
      await tx`select pg_advisory_xact_lock(hashtext('mediscan-order'))`;
      const byMail = await tx`select count(*)::int as c from mediscan.licenses
                                where lower(buyer_email) = ${buyer_email} and created_at > now() - interval '1 day'`;
      if (byMail[0].c >= 8) return { limited: true };
      const global = await tx`select count(*)::int as c from mediscan.licenses
                                where created_at > now() - interval '1 hour'`;
      if (global[0].c >= GLOBAL_PER_HOUR) return { limited: true };
      if (ip_hash) {
        try {
          const byIp = await tx`select count(*)::int as c from mediscan.order_attempts
                                  where ip_hash = ${ip_hash} and created_at > now() - interval '1 day'`;
          if (byIp[0].c >= IP_PER_DAY) return { limited: true };
          await tx`insert into mediscan.order_attempts (ip_hash) values (${ip_hash})`;
          await tx`delete from mediscan.order_attempts where created_at < now() - interval '7 days'`;
        } catch (e) {
          // Tabelle noch nicht migriert: ohne IP-Limit weiter (Savepoint waere noetig -> neu werfen, wenn nicht 42P01).
          if ((e as { code?: string })?.code !== "42P01") throw e;
          throw new MissingTable();
        }
      }
      const seq = await tx`select nextval('mediscan.order_seq') as v`;
      const ref = "MS-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
      const rows = await tx`insert into mediscan.licenses
          (order_ref, status, buyer_name, buyer_email, billing, price_cents, notes)
          values (${ref}, 'pending', ${buyer_name}, ${buyer_email}, ${billing}::jsonb, ${PRICE_CENTS},
                  ${"Selbstbestellung" + (waiver ? " · Verzicht Widerruf erteilt" : " · kein Verzicht: Code erst nach Widerrufsfrist")})
          returning access_token, order_ref`;
      return { limited: false, row: rows[0] };
    }).catch(async (e: unknown) => {
      if (!(e instanceof MissingTable)) throw e;
      // Fallback ohne IP-Tabelle (Migration noch nicht eingespielt).
      console.log("order: mediscan.order_attempts fehlt – Migration einspielen");
      return await sql.begin(async (tx: any) => {
        await tx`select pg_advisory_xact_lock(hashtext('mediscan-order'))`;
        const byMail = await tx`select count(*)::int as c from mediscan.licenses
                                  where lower(buyer_email) = ${buyer_email} and created_at > now() - interval '1 day'`;
        if (byMail[0].c >= 8) return { limited: true };
        const seq = await tx`select nextval('mediscan.order_seq') as v`;
        const ref = "MS-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
        const rows = await tx`insert into mediscan.licenses
            (order_ref, status, buyer_name, buyer_email, billing, price_cents, notes)
            values (${ref}, 'pending', ${buyer_name}, ${buyer_email}, ${billing}::jsonb, ${PRICE_CENTS},
                    ${"Selbstbestellung" + (waiver ? " · Verzicht Widerruf erteilt" : " · kein Verzicht: Code erst nach Widerrufsfrist")})
            returning access_token, order_ref`;
        return { limited: false, row: rows[0] };
      });
    });
    if (res.limited) return json({ error: "rate_limited" }, 429);
    access_token = res.row.access_token;
    order_ref = res.row.order_ref;
  } catch (_e) { return json({ error: "server_error" }, 500); }

  const payLink = SITE + "/zahlung.html?r=" + access_token;
  const amount = euro(PRICE_CENTS);

  const text = `Guten Tag ${buyer_name},

vielen Dank für Ihre Bestellung von MediScan.

Bestellnummer: ${order_ref}
Betrag: ${amount} (einmalig, keine Folgekosten)

Bitte begleichen Sie den Betrag per Überweisung. Ihre Rechnung mit allen
Bankdaten und einem QR-Code für Ihre Banking-App finden Sie hier:
${payLink}

Sobald Ihre Zahlung bei uns eingegangen ist, erhalten Sie Ihren persönlichen
Bestätigungscode per E-Mail, mit dem Sie MediScan dauerhaft freischalten.

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;

  const html = `<div style='font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16303f;max-width:560px;margin:0 auto'>`
    + `<h2 style='color:#00695c;margin:0 0 12px'>Vielen Dank für Ihre Bestellung</h2>`
    + `<p>Guten Tag ${esc(buyer_name)},</p><p>vielen Dank für Ihre Bestellung von MediScan.</p>`
    + `<table style='font-size:15px;border-collapse:collapse'>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5c7180'>Bestellnummer</td><td><b>${esc(order_ref)}</b></td></tr>`
    + `<tr><td style='padding:2px 12px 2px 0;color:#5c7180'>Betrag</td><td><b>${esc(amount)}</b> (einmalig, keine Folgekosten)</td></tr>`
    + `</table>`
    + `<p style='margin:22px 0'><a href='${esc(payLink)}' style='background:#00695c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block'>Rechnung ansehen &amp; bezahlen</a></p>`
    + `<p style='font-size:14px;color:#5c7180'>Oder Link kopieren:<br><span style='word-break:break-all'>${esc(payLink)}</span></p>`
    + `<p style='font-size:13px;color:#5c7180'>Sobald Ihre Zahlung eingegangen ist, erhalten Sie Ihren persönlichen <b>Bestätigungscode</b> per E-Mail, mit dem Sie MediScan dauerhaft freischalten.</p>`
    + `<p style='font-size:13px;color:#5c7180'>Herzliche Grüße<br>Ihr Vaydena-Team &middot; kontakt@vaydena.de</p></div>`;

  let emailed = false;
  const cust = await sendMail(buyer_email, "Ihre MediScan-Bestellung " + order_ref, text, html);
  emailed = cust.ok;
  try { console.log("order mail customer", cust.ok, cust.err || ""); } catch (_e) { /* ignore */ }

  try {
    const opTo = Deno.env.get("MAIL_FROM") || Deno.env.get("MAIL_USER") || "";
    if (opTo) {
      const opText = [
        "Neue MediScan-Bestellung",
        "",
        "Bestellnummer: " + order_ref,
        "Name: " + buyer_name,
        "E-Mail: " + buyer_email,
        "Rechnung an: " + bill_recipient + (bill_street ? (", " + bill_street) : "") + (bill_zip || bill_city ? (", " + bill_zip + " " + bill_city) : ""),
        "Betrag: " + amount,
        "Verzicht auf Widerrufsrecht: " + (waiver ? "JA – Code darf nach Zahlungseingang sofort versendet werden" : "NEIN – Code erst nach Ablauf der 14-tägigen Widerrufsfrist versenden"),
        "Zahlseite: " + payLink,
        "",
        "-> Nach Zahlungseingang im Betreiber-Bereich 'Bezahlt' markieren und 'Freischalten' (versendet den Bestätigungscode).",
      ].filter(Boolean).join("\n");
      await sendMail(opTo, "Neue MediScan-Bestellung: " + order_ref, opText, `<pre style='font-family:inherit;white-space:pre-wrap'>${esc(opText)}</pre>`);
    }
  } catch (_e) { /* ignore */ }

  return json({ ok: true, order_ref, access_token, pay_link: payLink, amount_cents: PRICE_CENTS, emailed });
});
