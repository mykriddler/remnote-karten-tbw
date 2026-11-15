// Senden der Tageszahlen an eine Lernzentrale (eigener Server mit Endpunkt /api/remnote/sync).
// Adresse und Zugangstoken stehen nur in den Plugin-Einstellungen von RemNote,
// nie im Quelltext.
// Auslöser: kurz nach dem Start, nach jeder Abfrage (QueueExit) und alle 15 Minuten,
// entprellt und mit mindestens 15 s Abstand zwischen zwei Sendeversuchen.
import { AppEvents, type ReactRNPlugin } from '@remnote/plugin-sdk';
import { tageszahlen } from './tageszahlen';

export const EINSTELLUNG_URL = 'lz-sync-url';
export const EINSTELLUNG_TOKEN = 'lz-sync-token';
const ALLE_MS = 15 * 60 * 1000;
const MIN_ABSTAND_MS = 15 * 1000;
let letzterSendeversuch = 0;
let geplant: any = null;
let wiederholtNach429 = false;

let laeuft = false;
let letzterStatus = 'noch nicht gesendet';
let timer: any = null;

/**
 * Format des Endpunkts /api/remnote/sync:
 * erlaubt sind due, reviewedToday, scheduledToday, totalCards, struggling (int), nextDue, capturedAt (ISO-String),
 * dueByDay ({"YYYY-MM-DD": int}, lokale Tage, höchstens 31). Andere Felder verwirft der Server still.
 * Zusätzlich newCards (int) und courses {TBW: {due, scheduledToday, reviewedToday, newCards}}.
 * decks (Zahlen je Wochenstapel) ist vorgesehen; ein Server, der es nicht kennt, verwirft es.
 */
/**
 * Zahlen je Lernbereich, wie RemNote sie unter „Heutiges Ziel“ zeigt:
 * - TBW (Prüfungsplaner): scheduledToday = Tagesziel, reviewedToday = heute gelernte Karten,
 *   due = noch übrig (Ziel minus gelernt), newCards = neuer Prüfungsstoff laut Plan für diese Woche.
 * - WiING (Ordner „Studium“, normaler Planer): due = heute fällig und noch offen,
 *   scheduledToday = due + heute gelernt, newCards = noch nie gelernte Karten.
 */
export function bereiche(z: Awaited<ReturnType<typeof tageszahlen>>) {
  const b: Record<string, { due: number; scheduledToday: number; reviewedToday: number; newCards: number }> = {};
  if (z.tbw) {
    // „erledigt“ = heute gelernt und heute nicht noch einmal dran; so zählt RemNote „Karten übrig“ herunter
    // (gemessen 15.11.2026: Ziel 89, 7 Karten gelernt, 2 davon heute erneut dran → RemNote 84 übrig).
    const erledigt = z.tbw.erledigt;
    const zielPlan = z.tagesstart?.ziel ?? z.plan?.ziel ?? null;
    const ziel = zielPlan != null ? zielPlan : z.tbw.faellig + erledigt;
    b.TBW = { due: Math.max(0, ziel - erledigt), scheduledToday: ziel, reviewedToday: erledigt, newCards: neuUebrig(z) };
  }
  if (z.studium) {
    const s = z.studium;
    b.WiING = { due: s.faellig, scheduledToday: s.faellig + s.erledigt, reviewedToday: s.erledigt, newCards: s.neu };
  }
  return b;
}

const STREAK_ZIEL = 10; // wie RemNote („Übe heute 10 Karten“)

/**
 * Auswertungen für die Seite „Lernstoff“: Lernverlauf mit Streak,
 * Antwortqualität und Fortschritt je Fach. Oben im Sync; ältere Lernzentralen verwerfen diese Felder still.
 */
export function auswertung(z: Awaited<ReturnType<typeof tageszahlen>>) {
  const bereiche: Record<string, any> = {};
  if (z.tbw) bereiche.TBW = z.tbw;
  if (z.studium) bereiche.WiING = z.studium;
  const days: Record<string, number> = {};
  const byCourse: Record<string, Record<string, number>> = {};
  const quality: Record<string, { again: number; hard: number; good: number; easy: number }> = {};
  for (const [kurs, b] of Object.entries(bereiche)) {
    byCourse[kurs] = { ...b.verlauf };
    for (const [t, n] of Object.entries(b.verlauf as Record<string, number>)) days[t] = (days[t] ?? 0) + n;
    const q = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const [s, n] of Object.entries(b.bewertungen as Record<string, number>)) {
      if (s === '0') q.again += n;
      else if (s === '0.5') q.hard += n;
      else if (s === '1') q.good += n;
      else if (s === '1.5') q.easy += n;
    }
    quality[kurs] = q;
  }
  // Streak: Tage am Stück mit mindestens STREAK_ZIEL Wiederholungen, bis heute (zählt heute erst ab Erreichen) bzw. gestern.
  let streak = 0;
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const key = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if ((days[key(d)] ?? 0) < STREAK_ZIEL) d.setDate(d.getDate() - 1);
  while ((days[key(d)] ?? 0) >= STREAK_ZIEL && streak < 30) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return {
    // höchstens 30 Tage je Reihe (Bodygrenze der Lernzentrale)
    history: {
      days, byCourse, streakDays: streak, streakGoal: STREAK_ZIEL,
      goals: Object.fromEntries(Object.entries(z.zielverlauf ?? {}).sort().slice(-30)),
    },
    quality: { periodDays: 30, ...quality },
    subjects: (z.faecher ?? []).slice(0, 30),
  };
}

/** Neuer Prüfungsstoff heute: Quote laut Plan minus heute aus dem Pool gelernte Karten (Pool-Start des Tages gespeichert). */
export function neuGelerntHeute(z: Awaited<ReturnType<typeof tageszahlen>>) {
  if (!z.tbw || !z.tagesstart) return 0;
  return Math.max(0, (z.tagesstart.poolNeu ?? 0) - z.tbw.poolNeu);
}
function neuUebrig(z: Awaited<ReturnType<typeof tageszahlen>>) {
  const quote = z.tagesstart?.neuQuote ?? z.plan?.neuWoche ?? 0;
  return Math.max(0, Math.min(quote, z.tbw?.poolNeu ?? quote) - neuGelerntHeute(z));
}

export function nutzlast(z: Awaited<ReturnType<typeof tageszahlen>>) {
  const tage = Object.keys(z.faelligJeTag).sort().slice(0, 31);
  const courses = bereiche(z);
  const summe = (k: 'due' | 'scheduledToday' | 'reviewedToday') => Object.values(courses).reduce((a, c) => a + c[k], 0);
  const body: any = {
    due: summe('due'),
    scheduledToday: summe('scheduledToday'),
    reviewedToday: summe('reviewedToday'),
    totalCards: (z.tbw?.karten ?? z.gesamt.karten) + (z.studium?.karten ?? 0),
    struggling: (z.tbw?.probleme ?? z.gesamt.probleme) + (z.studium?.probleme ?? 0),
    dueByDay: Object.fromEntries(tage.map((t) => [t, z.faelligJeTag[t]])),
    capturedAt: z.erfasst,
    newCards: (z.tbw?.neu ?? z.gesamt.neu) + (z.studium?.neu ?? 0),
    courses,
    decks: z.wochen.map((w: any) => ({
      remId: w.remId,
      title: w.titel,
      folder: w.ordner,
      week: w.woche,
      cards: w.karten,
      due: w.faellig,
      newCards: w.neu,
      reviewedToday: w.heute,
      struggling: w.probleme,
    })),
  };
  if (z.naechsteFaelligkeit) body.nextDue = z.naechsteFaelligkeit;
  Object.assign(body, auswertung(z));
  // Prüfungs-Countdown (ruhig, ohne Druck). Lokale Tage; die Resttage rechnet die Lernzentrale selbst.
  const p = z.plan;
  if (p?.pruefung && Array.isArray(p.zielSpanne)) {
    const tag = (t: number) => {
      const d = new Date(t);
      const n = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${n(d.getMonth() + 1)}-${n(d.getDate())}`;
    };
    body.exam = {
      course: 'TBW',
      date: tag(Date.parse(p.pruefung)),
      phase: p.aufholen ? 'catchUp' : 'regular',
      phaseUntil: p.aufholen ? p.aufholenBis : null,
      dailyGoalMin: Math.round(Number(p.zielSpanne[0]) || 0),
      dailyGoalMax: Math.round(Number(p.zielSpanne[1]) || 0),
    };
  }
  return body;
}

/**
 * Plant ein Senden (entprellt): Mehrere Auslöser kurz hintereinander ergeben genau ein Senden,
 * und zwischen zwei Sendeversuchen liegen mindestens MIN_ABSTAND_MS. Der Server drosselt
 * gültige Syncs auf etwa einen je 10 s und antwortet darüber mit 429.
 */
export function sendeBald(plugin: ReactRNPlugin, anlass: string, wartenMs = 5000) {
  if (geplant) clearTimeout(geplant);
  const frei = letzterSendeversuch + MIN_ABSTAND_MS - Date.now();
  geplant = setTimeout(() => {
    geplant = null;
    sendeJetzt(plugin, anlass);
  }, Math.max(wartenMs, frei, 0));
}

export async function sendeJetzt(plugin: ReactRNPlugin, anlass: string): Promise<string> {
  const frei = letzterSendeversuch + MIN_ABSTAND_MS - Date.now();
  if (laeuft || frei > 0) {
    sendeBald(plugin, anlass, Math.max(frei, 2000));
    return `${anlass}: kurz nach dem letzten Senden, wird in ${Math.ceil(Math.max(frei, 2000) / 1000)} s gesendet`;
  }
  laeuft = true;
  try {
    const url = ((await plugin.settings.getSetting<string>(EINSTELLUNG_URL)) ?? '').trim();
    const token = ((await plugin.settings.getSetting<string>(EINSTELLUNG_TOKEN)) ?? '').trim();
    if (!url || !token) {
      letzterStatus = 'nicht eingerichtet (Adresse oder Token fehlt in den Plugin-Einstellungen)';
      return letzterStatus;
    }
    const z = await tageszahlen(plugin);
    letzterSendeversuch = Date.now();
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lernzentrale-Token': token },
      body: JSON.stringify(nutzlast(z)),
    });
    const antwort = (await r.text()).slice(0, 120);
    letzterStatus = `${new Date().toLocaleString('de-DE')}: ${anlass}, HTTP ${r.status} ${antwort}`;
    if (r.status === 429 && !wiederholtNach429) {
      // Einmal später erneut versuchen (Retry-After, falls lesbar, sonst 30 s); danach wartet es auf den nächsten Auslöser.
      const sek = Number(r.headers.get('Retry-After')) || 30;
      wiederholtNach429 = true;
      sendeBald(plugin, anlass + ' (erneut nach 429)', Math.min(Math.max(sek, 10), 300) * 1000);
    } else {
      wiederholtNach429 = false;
    }
    return letzterStatus;
  } catch (e: any) {
    letzterStatus = `${new Date().toLocaleString('de-DE')}: ${anlass}, Fehler ${String(e?.message ?? e)}`;
    return letzterStatus;
  } finally {
    laeuft = false;
  }
}

export function status() {
  return letzterStatus;
}

export async function einrichten(plugin: ReactRNPlugin) {
  await plugin.settings.registerStringSetting({
    id: EINSTELLUNG_URL,
    title: 'Lernzentrale: Adresse der Aufnahmestelle',
    description: 'Vollständige Adresse des Endpunkts, z. B. https://<server>/api/remnote/sync',
    defaultValue: '',
  });
  await plugin.settings.registerStringSetting({
    id: EINSTELLUNG_TOKEN,
    title: 'Lernzentrale: Zugangstoken',
    description: 'Token aus den Einstellungen des Servers; einmal hier eintragen, bleibt nur in RemNote gespeichert.',
    defaultValue: '',
  });
  await plugin.app.registerCommand({
    id: 'lz-sync-jetzt',
    name: 'Lernzentrale: Lernkarten-Zahlen jetzt senden',
    action: async () => {
      await plugin.app.toast('Lernzentrale: ' + (await sendeJetzt(plugin, 'von Hand')));
    },
  });
  // Nach dem Verlassen der Abfrage einmal senden (entprellt), nie je Karte.
  plugin.event.addListener(AppEvents.QueueExit, undefined, () => {
    sendeBald(plugin, 'nach der Abfrage', 5000);
  });
  sendeBald(plugin, 'Start', 10000);
  if (timer) clearInterval(timer);
  timer = setInterval(() => sendeBald(plugin, 'alle 15 Minuten', 0), ALLE_MS);
}

export function beenden() {
  if (timer) clearInterval(timer);
  timer = null;
  if (geplant) clearTimeout(geplant);
  geplant = null;
}
