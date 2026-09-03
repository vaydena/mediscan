import postgres from "npm:postgres@3";
import QRCode from "npm:qrcode@1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });

// Feste Zahlungsempfaenger-Bankdaten des Betreibers (auf jeder Rechnung sichtbar).
const BANK = { holder: "Karl-Heinz Bicker", iban: "DE95700510030000785303", bic: "BYLADEM1FSI" };

// Rechnungssteller (Betreiber) + Steuerhinweis - erscheinen auf der PDF-Rechnung.
const ISSUER = {
  name: "Vaydena - Softwarelösungen",
  owner: "Karl-Heinz Bicker",
  street: "Biberstraße 27",
  zip: "85354",
  city: "Freising",
  email: "kontakt@vaydena.de",
  tel: "0151-24012554",
};
const TAX_NOTE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).";
const ITEM = "MediScan – einmaliger App-Zugang (Vollversion, dauerhaft)";

function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}
function dmy(s: unknown): string {
  if (!s) return "";
  const str = (s instanceof Date) ? s.toISOString() : String(s);
  const p = str.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : str;
}

// EPC069-12 (GiroCode) Nutzdaten
function buildEpcPayload(p: { holder: string; iban: string; bic: string; amount: number; reference: string }): string | null {
  const holder = p.holder.trim();
  const iban = p.iban.replace(/\s+/g, "").toUpperCase();
  const bic = (p.bic || "").replace(/\s+/g, "").toUpperCase();
  const reference = (p.reference || "").trim();
  if (!holder || holder.length > 70) return null;
  if (!iban || iban.length > 34) return null;
  if (bic && bic.length !== 8 && bic.length !== 11) return null;
  if (reference.length > 140) return null;
  if (!Number.isFinite(p.amount)) return null;
  const amount = Math.round(p.amount * 100) / 100;
  if (amount < 0.01 || amount > 999999999.99) return null;
  const lines = ["BCD", "002", "1", "SCT", bic, holder, iban, `EUR${amount.toFixed(2)}`, "", "", reference];
  const payload = lines.join("\n");
  if (new TextEncoder().encode(payload).length > 331) return null;
  return payload;
}

function buildGiro(p: { holder: string; iban: string; bic: string; amount: number; reference: string }): { path: string; size: number } | null {
  const payload = buildEpcPayload(p);
  if (!payload) return null;
  try {
    const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const quiet = 4;
    const size = n + quiet * 2;
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (data[r * n + c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { path, size };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const token = String(body?.access_token ?? "").trim();
  if (!token) return json({ found: false });
  try {
    const rows = await sql`
      select order_ref, status, price_cents, buyer_name, buyer_email, billing, paid_at, created_at
        from mediscan.licenses
       where access_token = ${token} limit 1`;
    if (rows.length === 0) return json({ found: false });
    const l = rows[0];
    const amount = (l.price_cents ?? 9900) / 100;
    // Bezahlt, sobald ein Zahlungseingang vermerkt ist (paid/active/revoked haben paid_at).
    const isPaid = !!l.paid_at;
    const reference = String(l.order_ref || "MediScan").slice(0, 140);
    const giro = isPaid ? null : buildGiro({ holder: BANK.holder, iban: BANK.iban, bic: BANK.bic, amount, reference });
    const bill = (l.billing && typeof l.billing === "object") ? l.billing : {};
    const billing = {
      recipient: (bill.recipient && String(bill.recipient).trim()) ? String(bill.recipient) : (l.buyer_name || ""),
      street: bill.street ? String(bill.street) : "",
      zip: bill.zip ? String(bill.zip) : "",
      city: bill.city ? String(bill.city) : "",
    };
    return json({
      found: true,
      number: l.order_ref,
      amount,
      unit_count: 1,
      unit_price: amount,
      item: ITEM,
      status: isPaid ? "paid" : "open",
      paid_at: l.paid_at,
      paid_at_dmy: dmy(l.paid_at),
      issued: l.created_at,
      issued_dmy: dmy(l.created_at),
      buyer_name: l.buyer_name,
      reference,
      bank: { holder: BANK.holder, iban: formatIban(BANK.iban), bic: BANK.bic },
      giro,
      billing,
      issuer: ISSUER,
      tax_note: TAX_NOTE,
    });
  } catch (_e) {
    return json({ error: "server_error" }, 500);
  }
});
