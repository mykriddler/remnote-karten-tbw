// Sprung in die Abfrage nach einem Kaltstart auf dem Handy (17.11.2026).
// Problem: Auf dem iPhone verwirft die RemNote-App einen Universal Link (https://www.remnote.com/flashcards/…),
// wenn sie dadurch erst gestartet wird; sie zeigt dann die Startseite. Die Lernzentrale merkt sich den Tipp
// (POST /api/remnote/sprung), das Plugin holt ihn beim Start ab (GET /api/remnote/sprung, höchstens 90 s alt,
// wird dabei verbraucht) und schickt RemNote selbst in die Abfrage.
// 0.3.6: In 0.3.5 wurde der Sprung am iPhone abgeholt, wirkte aber nicht (Test 17.11.2026, 23:23). Deshalb bleibt
// das Plugin jetzt bis zu 45 s dran und springt erneut, solange RemNote nicht in der Abfrage ist, und hält den
// Ablauf im synchronisierten Speicher fest (Schlüssel 'sprungDiagnose'), damit er am Rechner lesbar ist.
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import { EINSTELLUNG_TOKEN, EINSTELLUNG_URL } from './senden';

/** Erlaubte Ziele: nur die Abfrage, allgemein oder für ein Dokument. */
export const ZIEL_MUSTER = /^\/flashcards(\/[A-Za-z0-9]{5,40})?$/;
const FENSTER_MS = 60 * 1000;
const VERSUCHE_NACH_MS = [0, 5000, 12000];
const DRANBLEIBEN_MS = 45 * 1000;
const PRUEF_ABSTAND_MS = 1500;

let letzterSprung = 'noch nicht geprüft';
let protokoll: { start: number; geraet: string; schritte: [number, string][] } | null = null;

export function sprungStatus() {
  return letzterSprung;
}

function merke(text: string) {
  if (protokoll) protokoll.schritte.push([Date.now() - protokoll.start, text.slice(0, 160)]);
}

async function protokollSichern(plugin: ReactRNPlugin) {
  if (!protokoll) return;
  try {
    await plugin.storage.setSynced('sprungDiagnose', { ...protokoll, status: letzterSprung });
  } catch (_) {}
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

async function adresse(plugin: ReactRNPlugin) {
  try {
    return await plugin.window.getURL();
  } catch (e: any) {
    return 'Fehler getURL ' + String(e?.message ?? e);
  }
}

/**
 * Schickt RemNote in die Abfrage. getURL liefert einen Pfad wie /w/<kb>/notes~; setURL('/flashcards/<remId>')
 * öffnet die Abfrage des Dokuments (am PC getestet 17.11.2026, Desktop-App, Plugin 0.3.5).
 * Ist RemNote schon in einer Abfrage (der Link hat doch gewirkt), passiert nichts.
 * Mit dranbleibenMs > 0 wird danach regelmäßig nachgesehen und erneut gesprungen, solange RemNote nicht in der
 * Abfrage ist (beim Kaltstart kann RemNote danach noch selbst umschalten oder den ersten Befehl verwerfen).
 */
export async function oeffneAbfrage(plugin: ReactRNPlugin, ziel: string, dranbleibenMs = 0) {
  if (!ZIEL_MUSTER.test(ziel)) throw new Error('Ziel nicht erlaubt: ' + ziel);
  const aktuell = await adresse(plugin);
  merke('vorher ' + aktuell);
  if (inAbfrage(aktuell)) return { aktuell, gesprungen: false, versuche: 0 };
  let versuche = 0;
  const springe = async () => {
    versuche++;
    try {
      await plugin.window.setURL(ziel);
      merke('setURL ' + ziel);
    } catch (e: any) {
      merke('Fehler setURL ' + String(e?.message ?? e));
    }
  };
  await springe();
  const ende = Date.now() + dranbleibenMs;
  let stabil = 0;
  while (Date.now() < ende) {
    await new Promise((r) => setTimeout(r, PRUEF_ABSTAND_MS));
    const jetzt = await adresse(plugin);
    if (inAbfrage(jetzt)) {
      // zweimal hintereinander in der Abfrage: angekommen
      if (++stabil >= 2) {
        merke('angekommen ' + jetzt);
        break;
      }
    } else {
      stabil = 0;
      merke('nicht in Abfrage: ' + jetzt);
      await springe();
    }
  }
  const zuletzt = await adresse(plugin);
  return { aktuell, neu: ziel, gesprungen: true, versuche, zuletzt, angekommen: inAbfrage(zuletzt) };
}

async function holeSprung(adresse: string, token: string): Promise<string | null> {
  const r = await fetch(adresse, { method: 'GET', headers: { 'X-Lernzentrale-Token': token } });
  merke('GET sprung HTTP ' + r.status);
  if (r.status === 404) return null; // Lernzentrale kennt den Sprung noch nicht
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const ziel = typeof d?.open === 'string' ? d.open : null;
  merke('open ' + String(ziel));
  return ziel && ZIEL_MUSTER.test(ziel) ? ziel : null;
}

/**
 * Beim Start auf dem Handy: gemerkten Sprung abholen und ausführen. Läuft im Hintergrund; das Senden der
 * Tageszahlen wartet darauf (siehe senden.ts), damit es die Befehle an RemNote nicht ausbremst.
 */
export async function sprungNachStart(plugin: ReactRNPlugin, geraet = '') {
  const start = Date.now();
  protokoll = { start, geraet, schritte: [] };
  merke('Plugin-Start ' + new Date(start).toISOString());
  try {
    const url = ((await plugin.settings.getSetting<string>(EINSTELLUNG_URL)) ?? '').trim();
    const token = ((await plugin.settings.getSetting<string>(EINSTELLUNG_TOKEN)) ?? '').trim();
    const ziel_adresse = sprungAdresse(url);
    if (!ziel_adresse || !token) {
      letzterSprung = 'nicht eingerichtet';
      return;
    }
    for (const nach of VERSUCHE_NACH_MS) {
      const warten = start + nach - Date.now();
      if (warten > 0) await new Promise((r) => setTimeout(r, warten));
      if (Date.now() - start > FENSTER_MS) break;
      try {
        const ziel = await holeSprung(ziel_adresse, token);
        if (!ziel) {
          letzterSprung = `${new Date().toLocaleString('de-DE')}: kein Sprung offen`;
          return;
        }
        const e = await oeffneAbfrage(plugin, ziel, DRANBLEIBEN_MS);
        letzterSprung = `${new Date().toLocaleString('de-DE')}: ${ziel}, ` +
          (e.gesprungen ? `${e.versuche} Sprungbefehl(e), zuletzt ${e.zuletzt}` : 'war schon in der Abfrage');
        return;
      } catch (e: any) {
        letzterSprung = `${new Date().toLocaleString('de-DE')}: Fehler ${String(e?.message ?? e)}`;
        merke(letzterSprung);
      }
    }
  } catch (e: any) {
    letzterSprung = `${new Date().toLocaleString('de-DE')}: Fehler ${String(e?.message ?? e)}`;
  } finally {
    merke('Ende: ' + letzterSprung);
    await protokollSichern(plugin);
  }
}

/** Befehl zum Testen von Hand (auch am Handy über die Befehlssuche): springt in die Tagesabfrage. */
export async function sprungTestBefehl(plugin: ReactRNPlugin) {
  protokoll = { start: Date.now(), geraet: 'Befehl', schritte: [] };
  try {
    const e = await oeffneAbfrage(plugin, '/flashcards', 6000);
    letzterSprung = `${new Date().toLocaleString('de-DE')}: Test, ` +
      (e.gesprungen ? `${e.versuche} Sprungbefehl(e), zuletzt ${e.zuletzt}` : 'war schon in der Abfrage');
  } catch (e: any) {
    letzterSprung = `${new Date().toLocaleString('de-DE')}: Test, Fehler ${String(e?.message ?? e)}`;
  }
  merke('Ende: ' + letzterSprung);
  await protokollSichern(plugin);
  return letzterSprung;
}
