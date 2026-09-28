-- Rate-Limit je (gehashter) IP fuer die Selbstbestellung (mediscan-order).
-- Es wird nur ein gesalzener SHA-256-Hash gespeichert, keine Klar-IP; Eintraege
-- aelter als 7 Tage loescht die Funktion selbst.
create table if not exists mediscan.order_attempts (
  id         bigserial primary key,
  ip_hash    text        not null,
  created_at timestamptz not null default now()
);
create index if not exists order_attempts_ip_created_idx
  on mediscan.order_attempts (ip_hash, created_at);

-- Nur die Edge Function (direkte DB-Verbindung) greift zu; kein Zugriff ueber die API.
alter table mediscan.order_attempts enable row level security;
revoke all on mediscan.order_attempts from anon, authenticated;
