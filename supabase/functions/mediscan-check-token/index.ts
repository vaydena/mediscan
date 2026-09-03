import postgres from "npm:postgres@3";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

// Prueft einen Bestaetigungscode (MS-XXXXX-XXXXX-XXXXX). Der Vergleich ist
// unempfindlich gegen Bindestriche/Leerzeichen/Gross-/Kleinschreibung.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const norm = String(body?.token ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm) return json({ valid: false, reason: "unknown" });

  try {
    const rows = await sql`
      select order_ref, token, status, buyer_name, activated_at
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
      license: { order_ref: l.order_ref, buyer_name: l.buyer_name, activated_at: l.activated_at },
    });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
