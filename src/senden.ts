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
  const b: Record<string, { due: number; scheduledToday: number; reviewedToday: number; newCards: number; newLearnedToday?: number }> = {};
  if (z.tbw) {
    // „erledigt“ = heute gelernt und heute nicht noch einmal dran; so zählt RemNote „Karten übrig“ herunter
    // (gemessen 15.11.2026: Ziel 89, 7 Karten gelernt, 2 davon heute erneut dran → RemNote 84 übrig).
    const erledigt = z.tbw.erledigt;
    const zielPlan = z.tagesstart?.ziel ?? z.plan?.ziel ?? null;
    const ziel = zielPlan != null ? zielPlan : z.tbw.faellig + erledigt;
    // newLearnedToday: heute aus dem neuen Prüfungsstoff gelernt (Lernzentrale ab v0.5.14)
    b.TBW = { due: Math.max(0, ziel - erledigt), scheduledToday: ziel, reviewedToday: erledigt, newCards: neuUebrig(z), newLearnedToday: neuGelerntHeute(z) };
  }
  if (z.studium) {
    const s = z.studium;
    b.WiING = { due: s.faellig, scheduledToday: s.faellig + s.erledigt, reviewedToday: s.erledigt, newCards: s.neu };
  }
  return b;
}

const STREAK_ZIEL = 10; // wie RemNote („Übe heute 10 Karten“)
/**
 * Langer Lernverlauf (bis 400 Tage) und Lernminuten in history: erst ab Lernzentrale v0.5.18.
 * Bis v0.5.17 verwirft der Server history mit mehr als 31 Tagen ganz; deshalb ein Schalter in den
 * Plugin-Einstellungen (Standard aus), der nach dem Update der Lernzentrale umgelegt wird, ohne neue Plugin-Version.
 */
export const EINSTELLUNG_LANGER_VERLAUF = 'lz-langer-verlauf';
const KURZ_TAGE = 30;
const MAX_DOKUMENTE = 80;

type Z = Awaited<ReturnType<typeof tageszahlen>>;
const zahl = (n: any) => Math.max(0, Math.min(100000, Math.round(Number(n) || 0)));
function letzteTage(reihe: Record<string, number>, n: number) {
  return Object.fromEntries(Object.entries(reihe).filter(([, v]) => v > 0).sort().slice(-n).map(([t, v]) => [t, zahl(v)]));
}
function montagVon(tag: string) {
  const [j, m, d] = tag.split('-').map(Number);
  const x = new Date(j, m - 1, d, 12);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  const n = (v: number) => String(v).padStart(2, '0');
  return `${x.getFullYear()}-${n(x.getMonth() + 1)}-${n(x.getDate())}`;
}

/**
 * Anstehende Karten heute + 30 Tage je Kurs: reviews aus den nächsten Terminen der schon gelernten Karten
 * (Überfälliges zählt auf heute), new für TBW laut Prüfungsplaner (Tagesquote der Woche, solange der
 * neue Prüfungsstoff reicht; heute = noch offene Quote). WiING: Der normale Planer gibt neue Karten nach
 * einer Einstellung frei, die ein Plugin nicht lesen kann, daher new = 0.
 */
export function prognose(z: Z) {
  const jeKurs: Record<string, Record<string, { reviews: number; new: number }>> = {};
  if (z.tbw) {
    const heuteNeu = neuUebrig(z);
    let vorrat = Math.max(0, (z.tbw.poolNeu ?? 0) - heuteNeu);
    const wochen: Record<string, number> = (z.plan as any)?.neuJeWoche ?? {};
    const r: Record<string, { reviews: number; new: number }> = {};
    Object.keys(z.tbw.prognose).sort().forEach((t, i) => {
      let neu = heuteNeu;
      if (i > 0) {
        const quote = zahl(wochen[montagVon(t)] ?? 0);
        neu = Math.min(quote, vorrat);
        vorrat -= neu;
      }
      r[t] = { reviews: zahl(z.tbw!.prognose[t]), new: zahl(neu) };
    });
    jeKurs.TBW = r;
  }
  if (z.studium) {
    jeKurs.WiING = Object.fromEntries(Object.keys(z.studium.prognose).sort().map((t) => [t, { reviews: zahl(z.studium!.prognose[t]), new: 0 }]));
  }
  const gesamt: Record<string, { reviews: number; new: number }> = {};
  for (const r of Object.values(jeKurs))
    for (const [t, v] of Object.entries(r)) {
      const g = (gesamt[t] ??= { reviews: 0, new: 0 });
      g.reviews = zahl(g.reviews + v.reviews);
      g.new = zahl(g.new + v.new);
    }
  return { forecast: gesamt, forecastByCourse: jeKurs };
}

/** Hinzugefügte Karten je Woche (Montag), letzte 12 Wochen. */
export function zugaenge(z: Z) {
  const jeKurs: Record<string, Record<string, number>> = {};
  if (z.tbw) jeKurs.TBW = Object.fromEntries(Object.entries(z.tbw.zugaenge).map(([t, v]) => [t, zahl(v)]));
  if (z.studium) jeKurs.WiING = Object.fromEntries(Object.entries(z.studium.zugaenge).map(([t, v]) => [t, zahl(v)]));
  const gesamt: Record<string, number> = {};
  for (const r of Object.values(jeKurs)) for (const [t, v] of Object.entries(r)) gesamt[t] = zahl((gesamt[t] ?? 0) + v);
  return { added: gesamt, addedByCourse: jeKurs };
}

/**
 * Dokumentenbaum beider Kurse, höchstens 80 Einträge: zuerst die oberen Ebenen (Teile, Fächer), dann tiefer,
 * ausgegeben in RemNote-Reihenfolge (TBW vor WiING).
 */
export function dokumente(z: Z) {
  const alle: any[] = [];
  const dazu = (kurs: string, b: any) => {
    for (const d of b?.dokumente ?? []) alle.push({ kurs, d, nr: alle.length });
  };
  dazu('TBW', z.tbw);
  dazu('WiING', z.studium);
  const auswahl = [...alle].sort((a, b) => a.d.tiefe - b.d.tiefe || a.nr - b.nr).slice(0, MAX_DOKUMENTE).sort((a, b) => a.nr - b.nr);
  return auswahl.map(({ kurs, d }) => ({
    course: kurs,
    path: d.path.slice(0, 4).map((p: string) => p.slice(0, 80)),
    name: d.name.slice(0, 80),
    remId: d.remId,
    cards: zahl(d.cards),
    due: zahl(d.due),
    new: zahl(d.new),
    learned: zahl(d.learned),
    // „wo muss ich mehr tun“: Arbeit und Antworten der letzten 30 Tage, schwierige Karten (2× oder öfter in Folge falsch)
    reviews30: zahl(d.reviews30),
    struggling: zahl(d.struggling),
    again: zahl(d.again),
    hard: zahl(d.hard),
    good: zahl(d.good),
    easy: zahl(d.easy),
  }));
}

/**
 * Auswertungen für die Seite „Lernstoff“: Lernverlauf mit Streak,
 * Antwortqualität und Fortschritt je Fach. Oben im Sync; ältere Lernzentralen verwerfen diese Felder still.
 */
export function auswertung(z: Awaited<ReturnType<typeof tageszahlen>>, LANGER_VERLAUF = false) {
  const bereiche: Record<string, any> = {};
  if (z.tbw) bereiche.TBW = z.tbw;
  if (z.studium) bereiche.WiING = z.studium;
  const days: Record<string, number> = {};
  const byCourse: Record<string, Record<string, number>> = {};
  const quality: Record<string, { again: number; hard: number; good: number; easy: number }> = {};
  for (const [kurs, b] of Object.entries(bereiche)) {
    byCourse[kurs] = { ...(b.verlaufLang ?? b.verlauf) };
    for (const [t, n] of Object.entries((b.verlaufLang ?? b.verlauf) as Record<string, number>)) days[t] = (days[t] ?? 0) + n;
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
  while ((days[key(d)] ?? 0) >= STREAK_ZIEL && streak < 400) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  // Bis Lernzentrale v0.5.17 höchstens 30 Tage je Reihe; ab v0.5.18 (LANGER_VERLAUF) bis 400 Tage samt Lernminuten.
  const n = LANGER_VERLAUF ? 400 : KURZ_TAGE;
  const history: any = {
    days: letzteTage(days, n),
    byCourse: Object.fromEntries(Object.entries(byCourse).map(([k, r]) => [k, letzteTage(r, n)])),
    streakDays: streak,
    streakGoal: STREAK_ZIEL,
    goals: Object.fromEntries(Object.entries(z.zielverlauf ?? {}).sort().slice(-30)),
  };
  if (LANGER_VERLAUF) {
    const minuten: Record<string, number> = {};
    for (const b of Object.values(bereiche))
      for (const [t, m] of Object.entries((b.minuten ?? {}) as Record<string, number>)) minuten[t] = (minuten[t] ?? 0) + m;
    if (Object.keys(minuten).length) history.minutes = letzteTage(minuten, 400);
  }
  return {
    history,
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

export function nutzlast(z: Awaited<ReturnType<typeof tageszahlen>>, langerVerlauf = false) {
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
  Object.assign(body, auswertung(z, langerVerlauf), prognose(z), zugaenge(z));
  body.documents = dokumente(z);
  // Aufholstapel des Prüfungsplaners (nur TBW; WiING hat keinen Prüfungsplaner, dort stecken nie gelernte fällige Karten schon in courses.WiING.due)
  if (z.tbw) body.backlog = { TBW: zahl(z.tbw.aufholstapel), WiING: 0 };
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
    // Token und Zahlen nur verschlüsselt übertragen
    if (!/^https:\/\//i.test(url)) {
      letzterStatus = 'nicht gesendet: Die Adresse muss mit https:// beginnen';
      return letzterStatus;
    }
    const z = await tageszahlen(plugin);
    letzterSendeversuch = Date.now();
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lernzentrale-Token': token },
      body: JSON.stringify(nutzlast(z, await langerVerlauf(plugin))),
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

export async function langerVerlauf(plugin: ReactRNPlugin) {
  try {
    return !!(await plugin.settings.getSetting<boolean>(EINSTELLUNG_LANGER_VERLAUF));
  } catch (_) {
    return false;
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
  await plugin.settings.registerBooleanSetting({
    id: EINSTELLUNG_LANGER_VERLAUF,
    title: 'Lernzentrale: langen Lernverlauf senden (400 Tage, Lernminuten)',
    description: 'Erst einschalten, wenn die Lernzentrale Version 0.5.18 oder neuer hat; ältere Versionen verwerfen sonst den ganzen Lernverlauf.',
    defaultValue: false,
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
