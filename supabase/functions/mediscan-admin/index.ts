import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const SITE = "https://mediscan.vaydena.de";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bestaetigungscode-Alphabet ohne verwechselbare Zeichen (kein I L O 0 1).
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(15));
  let s = "";
  for (let i = 0; i < 15; i++) s += ALPHA[b[i] % ALPHA.length];
  return "MS-" + s.slice(0, 5) + "-" + s.slice(5, 10) + "-" + s.slice(10, 15);
}

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
function esc(s: unknown) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)); }

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

// Aktivierungs-/Bestaetigungscode-Mail an den Kaeufer.
async function mailCode(to: string, name: string, order_ref: string, code: string) {
  if (!to) return { ok: false, err: "no_recipient" };
  const openLink = SITE + "/app.html?k=" + encodeURIComponent(code);
  const text = `Guten Tag ${name || ""},

vielen Dank – Ihre Zahlung ist eingegangen. MediScan ist jetzt für Sie freigeschaltet.

Bestellnummer: ${order_ref}
Ihr Bestätigungscode: ${code}

So schalten Sie MediScan frei:
1) Öffnen Sie ${SITE}/app.html
2) Geben Sie Ihren Bestätigungscode ein: ${code}

Oder direkt per Ein-Klick-Link (Code ist enthalten):
${openLink}

Nach der einmaligen Freischaltung funktioniert MediScan dauerhaft und auch
offline auf diesem Gerät. Bitte behandeln Sie Ihren Code vertraulich – er gilt
für Ihren persönlichen Zugang.

Herzliche Grüße
Ihr Vaydena-Team
kontakt@vaydena.de`;
  const html = `<div style='font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#16303f;max-width:560px;margin:0 auto'>`
    + `<h2 style='color:#00695c;margin:0 0 12px'>MediScan ist freigeschaltet</h2>`
    + `<p>Guten Tag ${esc(name)},</p><p>vielen Dank – Ihre Zahlung ist eingegangen. MediScan ist jetzt für Sie freigeschaltet.</p>`
    + `<p style='font-size:14px;color:#5c7180;margin:0 0 4px'>Bestellnummer ${esc(order_ref)} · Ihr Bestätigungscode:</p>`
    + `<p style='font-size:24px;font-weight:800;letter-spacing:.06em;color:#00695c;background:#e0f2f1;border-radius:10px;padding:14px 18px;text-align:center;font-family:ui-monospace,Consolas,monospace'>${esc(code)}</p>`
    + `<p style='margin:22px 0'><a href='${esc(openLink)}' style='background:#00695c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block'>MediScan öffnen &amp; freischalten</a></p>`
    + `<p style='font-size:14px;color:#5c7180'>Oder öffnen Sie <b>${SITE}/app.html</b> und geben den Code oben ein.</p>`
    + `<p style='font-size:13px;color:#5c7180'>Nach der einmaligen Freischaltung funktioniert MediScan dauerhaft und auch offline auf diesem Gerät. Bitte behandeln Sie Ihren Code vertraulich.</p>`
    + `<p style='font-size:13px;color:#5c7180'>Herzliche Grüße<br>Ihr Vaydena-Team &middot; kontakt@vaydena.de</p></div>`;
  return await sendMail(to, "Ihr MediScan-Bestätigungscode – jetzt freischalten", text, html);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = req.headers.get("x-admin-key") ?? "";
  if (!key) return json({ error: "unauthorized" }, 401);
  let hash: string;
  try { hash = await sha256hex(key); } catch { return json({ error: "server_error" }, 500); }
  try {
    const auth = await sql`select secret_sha256 from mediscan.admin_auth where id = 1 limit 1`;
    if (auth.length === 0 || !safeEqual(String(auth[0].secret_sha256), hash)) {
      return json({ error: "unauthorized" }, 401);
    }
  } catch { return json({ error: "server_error" }, 500); }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "").trim();

  try {
    if (action === "list") {
      const rows = await sql`
        select id, order_ref, token, status, buyer_name, buyer_email, price_cents,
               created_at, paid_at, activated_at, revoked_at, notes
          from mediscan.licenses
         order by created_at desc`;
      const counts = await sql`
        select
          count(*) filter (where status = 'pending')::int as pending,
          count(*) filter (where status = 'paid')::int    as paid,
          count(*) filter (where status = 'active')::int  as active,
          count(*) filter (where status = 'revoked')::int as revoked
        from mediscan.licenses`;
      return json({ ok: true, licenses: rows, counts: counts[0] });
    }

    if (action === "get") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const rows = await sql`select id, order_ref, token, access_token, status, buyer_name, buyer_email,
                                    billing, price_cents, notes, created_at, paid_at, activated_at, revoked_at
                               from mediscan.licenses where id = ${id} limit 1`;
      if (rows.length === 0) return json({ error: "not_found" }, 404);
      return json({ ok: true, license: rows[0], pay_link: SITE + "/zahlung.html?r=" + rows[0].access_token });
    }

    if (action === "create") {
      const name = String(body?.buyer_name ?? "").trim();
      if (name.length < 2) return json({ error: "bad_name" }, 400);
      const email = (typeof body?.buyer_email === "string" && body.buyer_email.trim() !== "") ? body.buyer_email.trim().toLowerCase() : null;
      const notes = String(body?.notes ?? "").trim().slice(0, 500) || "Manuell angelegt";
      const bill = (body?.billing && typeof body.billing === "object" && !Array.isArray(body.billing)) ? body.billing : {};
      const seq = await sql`select nextval('mediscan.order_seq') as v`;
      const order_ref = "MS-" + new Date().getFullYear() + "-" + String(seq[0].v).padStart(4, "0");
      const rows = await sql`insert into mediscan.licenses
          (order_ref, status, buyer_name, buyer_email, billing, price_cents, notes)
          values (${order_ref}, 'pending', ${name}, ${email}, ${bill}::jsonb, 9900, ${notes})
          returning id, order_ref, access_token, status, buyer_name, buyer_email, created_at`;
      return json({ ok: true, license: rows[0], pay_link: SITE + "/zahlung.html?r=" + rows[0].access_token });
    }

    if (action === "set_paid") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const rows = await sql`update mediscan.licenses
          set status = case when status = 'pending' then 'paid' else status end,
              paid_at = coalesce(paid_at, now())
          where id = ${id} and status in ('pending','paid')
          returning id, order_ref, status, paid_at`;
      if (rows.length === 0) return json({ error: "not_found_or_wrong_status" }, 404);
      return json({ ok: true, license: rows[0] });
    }

    if (action === "activate" || action === "resend_code") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const pre = await sql`select id, order_ref, token, status, buyer_name, buyer_email from mediscan.licenses where id = ${id} limit 1`;
      if (pre.length === 0) return json({ error: "not_found" }, 404);
      const lic = pre[0];
      if (action === "activate" && lic.status === "revoked") return json({ error: "is_revoked" }, 409);
      if (action === "resend_code" && !lic.token) return json({ error: "no_code_yet" }, 409);

      let row: any = null;
      if (lic.token) {
        const r = await sql`update mediscan.licenses
            set status = 'active', activated_at = coalesce(activated_at, now()), paid_at = coalesce(paid_at, now()), revoked_at = null
            where id = ${id}
            returning id, order_ref, token, status, buyer_name, buyer_email, activated_at`;
        row = r[0];
      } else {
        let ok = false;
        for (let i = 0; i < 6 && !ok; i++) {
          const cand = genCode();
          try {
            const r = await sql`update mediscan.licenses
                set token = ${cand}, status = 'active', activated_at = coalesce(activated_at, now()), paid_at = coalesce(paid_at, now())
                where id = ${id}
                returning id, order_ref, token, status, buyer_name, buyer_email, activated_at`;
            row = r[0]; ok = true;
          } catch (_e) { /* unique-violation auf token -> neuen Code versuchen */ }
        }
        if (!ok) return json({ error: "code_gen_failed" }, 500);
      }

      const m = await mailCode(String(row.buyer_email || ""), String(row.buyer_name || ""), String(row.order_ref || ""), String(row.token || ""));
      try { console.log("activate mail", m.ok, m.err || ""); } catch (_e) { /* ignore */ }
      return json({ ok: true, license: row, emailed: m.ok, mail_error: m.ok ? null : m.err });
    }

    if (action === "revoke") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      const rows = await sql`update mediscan.licenses
          set status = 'revoked', revoked_at = now()
          where id = ${id} returning id, order_ref, status, revoked_at`;
      if (rows.length === 0) return json({ error: "not_found" }, 404);
      return json({ ok: true, license: rows[0] });
    }

    if (action === "unrevoke") {
      const id = String(body?.id ?? "").trim().toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "bad_id" }, 400);
      // Zurueck auf aktiv, wenn ein Code existiert, sonst auf 'paid' (dann kann neu freigeschaltet werden).
      const rows = await sql`update mediscan.licenses
          set status = case when token is not null then 'active' else 'paid' end,
              revoked_at = null,
              activated_at = case when token is not null then coalesce(activated_at, now()) else activated_at end
          where id = ${id} and status = 'revoked'
          returning id, order_ref, token, status`;
      if (rows.length === 0) return json({ error: "not_found_or_not_revoked" }, 404);
      return json({ ok: true, license: rows[0] });
    }

    if (action === "export") {
      const rows = await sql`select id, order_ref, token, access_token, status, buyer_name, buyer_email,
                                    billing, price_cents, notes, created_at, paid_at, activated_at, revoked_at
                               from mediscan.licenses order by created_at`;
      return json({ ok: true, exported_at: new Date().toISOString(), count: rows.length, licenses: rows });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
