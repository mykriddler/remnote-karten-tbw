// Sprung in die Abfrage nach einem Kaltstart auf dem Handy (17.11.2026).
// Problem: Auf dem iPhone verwirft die RemNote-App einen Universal Link (https://www.remnote.com/flashcards/…),
// wenn sie dadurch erst gestartet wird; sie zeigt dann die Startseite. Die Lernzentrale merkt sich den Tipp
// (POST /api/remnote/sprung), das Plugin holt ihn beim Start ab (GET /api/remnote/sprung, höchstens 90 s alt,
// wird dabei verbraucht) und schickt RemNote selbst in die Abfrage.
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import { EINSTELLUNG_TOKEN, EINSTELLUNG_URL } from './senden';

/** Erlaubte Ziele: nur die Abfrage, allgemein oder für ein Dokument. */
export const ZIEL_MUSTER = /^\/flashcards(\/[A-Za-z0-9]{5,40})?$/;
const FENSTER_MS = 60 * 1000;
const VERSUCHE_NACH_MS = [0, 5000, 12000];

let letzterSprung = 'noch nicht geprüft';

export function sprungStatus() {
  return letzterSprung;
}

/** Aus der Sync-Adresse …/api/remnote/sync die Adresse …/api/remnote/sprung machen. */
export function sprungAdresse(syncUrl: string): string | null {
  const u = syncUrl.trim();
  if (!/^https:\/\//i.test(u)) return null;
  if (!/\/sync\/?$/.test(u)) return null;
  return u.replace(/\/sync\/?$/, '/sprung');
}

function inAbfrage(adresse: string) {
  try {
    return /\/flashcards(\/|$)/.test(new URL(adresse, 'https://x').pathname);
  } catch (_) {
    return false;
  }
}

/**
 * Schickt RemNote in die Abfrage. getURL liefert einen Pfad wie /w/<kb>/notes~; setURL('/flashcards/<remId>')
 * öffnet die Abfrage des Dokuments (am PC getestet 17.11.2026, Desktop-App, Plugin 0.3.5).
 * Ist RemNote schon in einer Abfrage (der Link hat doch gewirkt), passiert nichts.
 */
export async function oeffneAbfrage(plugin: ReactRNPlugin, ziel: string, nachpruefenMs = 0) {
  if (!ZIEL_MUSTER.test(ziel)) throw new Error('Ziel nicht erlaubt: ' + ziel);
  const aktuell = await plugin.window.getURL();
  if (inAbfrage(aktuell)) return { aktuell, gesprungen: false };
  await plugin.window.setURL(ziel);
  // Beim Kaltstart kann RemNote danach noch selbst auf die Startseite umschalten: einmal nachsehen und erneut springen.
  if (nachpruefenMs > 0) {
    await new Promise((r) => setTimeout(r, nachpruefenMs));
    if (!inAbfrage(await plugin.window.getURL())) await plugin.window.setURL(ziel);
  }
  return { aktuell, neu: ziel, gesprungen: true };
}

async function holeSprung(adresse: string, token: string): Promise<string | null> {
  const r = await fetch(adresse, { method: 'GET', headers: { 'X-Lernzentrale-Token': token } });
  if (r.status === 404) return null; // Lernzentrale kennt den Sprung noch nicht
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const ziel = typeof d?.open === 'string' ? d.open : null;
  return ziel && ZIEL_MUSTER.test(ziel) ? ziel : null;
}

/** Beim Start auf dem Handy: gemerkten Sprung abholen und ausführen. Läuft still im Hintergrund. */
export async function sprungNachStart(plugin: ReactRNPlugin) {
  const start = Date.now();
  try {
    const url = ((await plugin.settings.getSetting<string>(EINSTELLUNG_URL)) ?? '').trim();
    const token = ((await plugin.settings.getSetting<string>(EINSTELLUNG_TOKEN)) ?? '').trim();
    const adresse = sprungAdresse(url);
    if (!adresse || !token) {
      letzterSprung = 'nicht eingerichtet';
      return;
    }
    for (const nach of VERSUCHE_NACH_MS) {
      const warten = start + nach - Date.now();
      if (warten > 0) await new Promise((r) => setTimeout(r, warten));
      if (Date.now() - start > FENSTER_MS) break;
      try {
        const ziel = await holeSprung(adresse, token);
        if (!ziel) {
          letzterSprung = `${new Date().toLocaleString('de-DE')}: kein Sprung offen`;
          return;
        }
        const e = await oeffneAbfrage(plugin, ziel, 3000);
        letzterSprung = `${new Date().toLocaleString('de-DE')}: ${ziel}, ${e.gesprungen ? 'gesprungen' : 'war schon in der Abfrage'}`;
        return;
      } catch (e: any) {
        letzterSprung = `${new Date().toLocaleString('de-DE')}: Fehler ${String(e?.message ?? e)}`;
      }
    }
  } catch (e: any) {
    letzterSprung = `${new Date().toLocaleString('de-DE')}: Fehler ${String(e?.message ?? e)}`;
  }
}
