#!/usr/bin/env python3
"""Erzeugt die Vorlese-Aufnahmen (Stimme Seraphina) fuer MediScan.

Eingabe:  tools/tts-texts.json  {hash: text}  (erzeugt mit: node tools/tts_extract.js)
Ausgabe:  media/tts/<hash>.mp3  und  media/tts/index.json  (Liste der vorhandenen Hashes)

Gleiche Stimme und gleiches Tempo wie im Aufklaerungsbogen:
de-DE-SeraphinaMultilingualNeural, Rate -6 %. Laeuft im GitHub-Workflow tts.yml
(der Microsoft-Dienst braucht eine WebSocket-Verbindung).
Nur generische Texte der Referenzdatenbank - niemals Nutzer- oder Gesundheitsdaten.

Zeitbudget (Umgebungsvariable TTS_BUDGET_MIN, Standard 300): Danach werden keine neuen
Aufnahmen mehr begonnen; der Workflow committet den Zwischenstand, ein erneuter Lauf
setzt fort.
"""
import asyncio, json, os, re, sys, time

VOICE = "de-DE-SeraphinaMultilingualNeural"
RATE = "-6%"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXTS = os.path.join(ROOT, "tools", "tts-texts.json")
OUT = os.path.join(ROOT, "media", "tts")
BUDGET = float(os.environ.get("TTS_BUDGET_MIN", "300")) * 60
START = time.monotonic()

# Nur fuer die Aussprache; der angezeigte Text (und damit der Schluessel) bleibt unveraendert.
SPOKEN = [
    (r"\bz\.\s?B\.", "zum Beispiel"), (r"\bggf\.", "gegebenenfalls"), (r"\bv\.\s?a\.", "vor allem"),
    (r"\bu\.\s?a\.", "unter anderem"), (r"\bd\.\s?h\.", "das heißt"), (r"\bbzw\.", "beziehungsweise"),
    (r"\bevtl\.", "eventuell"), (r"\binkl\.", "inklusive"), (r"\bca\.", "circa"), (r"\bNr\.", "Nummer"),
    (r"\bu\.\s?U\.", "unter Umständen"), (r"\bsog\.", "sogenannte"), (r"\bi\.\s?v\.", "intravenös"),
    (r"Ärztin/Arzt", "Ärztin oder Arzt"), (r"Arzt/Apotheke", "Arzt oder Apotheke"),
    (r"\s*&\s*", " und "),  # sonst liest die Stimme "&" englisch ("and") und wechselt die Aussprache
]

def spoken(t):
    for a, b in SPOKEN:
        t = re.sub(a, b, t)
    return t

async def one(h, text, sem, failed, skipped):
    path = os.path.join(OUT, h + ".mp3")
    async with sem:
        if time.monotonic() - START > BUDGET:
            skipped.append(h); return
        for attempt in range(4):
            try:
                tmp = path + ".part"
                await edge_tts.Communicate(spoken(text), VOICE, rate=RATE).save(tmp)
                if os.path.getsize(tmp) < 1000:
                    raise RuntimeError("zu kleine Datei")
                os.replace(tmp, path)
                print("OK  ", h, text[:70]); return
            except Exception as e:
                print("WARN", h, attempt + 1, e); await asyncio.sleep(3 * (attempt + 1))
        failed.append(h)

async def main():
    texts = json.load(open(TEXTS, encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    # Aufnahmen, deren Text nicht mehr vorkommt, entfernen
    for fn in os.listdir(OUT):
        if fn.endswith(".part") or (fn.endswith(".mp3") and fn[:-4] not in texts):
            os.remove(os.path.join(OUT, fn)); print("DEL ", fn)
    todo = {h: t for h, t in texts.items() if not os.path.exists(os.path.join(OUT, h + ".mp3"))}
    print(len(texts), "Texte,", len(todo), "neu zu erzeugen")
    failed, skipped, sem = [], [], asyncio.Semaphore(4)
    await asyncio.gather(*(one(h, t, sem, failed, skipped) for h, t in todo.items()))
    have = sorted(fn[:-4] for fn in os.listdir(OUT) if fn.endswith(".mp3"))
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(have, f)
    print(len(have), "Aufnahmen vorhanden,", len(failed), "fehlgeschlagen,", len(skipped), "wegen Zeitbudget offen")
    if failed or skipped:
        sys.exit(1)

if __name__ == "__main__":
    import edge_tts  # nur fuer die Erzeugung noetig
    asyncio.run(main())
