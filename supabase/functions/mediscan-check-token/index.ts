import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

// ---- Rate-Limit (per IP, festes Zeitfenster) ------------------------------
// Speichert nur den SHA-256-Hash der IP (keine Roh-IP/PII), Zeilen sind kurzlebig.
// Faellt bei DB-Fehlern bewusst OFFEN (true), damit niemand ausgesperrt wird.
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return first || (req.headers.get("cf-connecting-ip") || "").trim() || "unknown";
}
async function rateOk(bucket: string, ip: string, limit: number, windowSecs: number): Promise<boolean> {
  try {
    const iph = (await sha256hex(ip)).slice(0, 40);
    const rows = await sql`
      insert into mediscan.rate_hits (bucket, iphash, reset_at, hits)
      values (${bucket}, ${iph}, now() + make_interval(secs => ${windowSecs}), 1)
      on conflict (bucket, iphash) do update set
        hits = case when mediscan.rate_hits.reset_at < now() then 1 else mediscan.rate_hits.hits + 1 end,
        reset_at = case when mediscan.rate_hits.reset_at < now() then now() + make_interval(secs => ${windowSecs}) else mediscan.rate_hits.reset_at end
      returning hits`;
    if (Math.random() < 0.02) {
      try { await sql`delete from mediscan.rate_hits where reset_at < now() - interval '1 day'`; } catch (_e) { /* egal */ }
    }
    return Number(rows[0].hits) <= limit;
  } catch (_e) {
    return true; // fail-open: Limiter darf niemanden aussperren
  }
}

// Prueft einen Bestaetigungscode (MS-XXXXX-XXXXX-XXXXX). Der Vergleich ist
// unempfindlich gegen Bindestriche/Leerzeichen/Gross-/Kleinschreibung.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const norm = String(body?.token ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm) return json({ valid: false, reason: "unknown" });

  // Max. 60 Abfragen/Minute je IP. Antwort bewusst NICHT als JSON, damit der
  // Client sie als "kurz nicht erreichbar" behandelt und nicht als ungueltigen Code.
  if (!(await rateOk("check", clientIp(req), 60, 60))) {
    return new Response("rate_limited", { status: 429, headers: cors });
  }

  try {
    const rows = await sql`
      select order_ref, token, status, activated_at
        from mediscan.licenses
       where token is not null
         and regexp_replace(upper(token), '[^A-Z0-9]', '', 'g') = ${norm}
       limit 1`;
    if (rows.length === 0) return json({ valid: false, reason: "unknown" });
    const l = rows[0];
    if (l.status === "revoked") return json({ valid: false, reason: "revoked" });
    if (l.status !== "active") return json({ valid: false, reason: "not_active" });
    return json({
      valid: true,
      license: { order_ref: l.order_ref, activated_at: l.activated_at },
    });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
