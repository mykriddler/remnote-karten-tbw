// Tageszahlen für die Lernzentrale.
// Zählt je Wochendokument unter TBW die Karten nach Fälligkeit. Nur Lesen, nichts wird verändert.
// Begriffe:
//   neu        Karte ohne Wiederholung (noch nie gelernt)
//   faellig    schon gelernte Karte, deren nächster Termin bis Ende heute liegt
//   heute      Wiederholungen mit Datum heute (gelernte Karten heute)
//   probleme   Karten, die zweimal oder öfter in Folge falsch waren
import type { ReactRNPlugin } from '@remnote/plugin-sdk';

const TAG = 24 * 60 * 60 * 1000;
export const VERLAUF_TAGE = 400; // Lernverlauf rückwärts (Heatmap der Lernzentrale)
export const PROGNOSE_TAGE = 30; // anstehende Karten: heute + 30 Tage
export const ZUGANG_WOCHEN = 12; // hinzugefügte Karten je Woche
const MAX_TIEFE = 4; // Ebenen des Dokumentenbaums unterhalb des Kursordners
const ANTWORT_MAX_MS = 2 * 60 * 1000; // eine Antwort zählt höchstens 2 Minuten (Pausen vor offener Karte nicht mitzählen)

function tagesbeginn(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function datum(t: number) {
  const d = new Date(t);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

async function klar(plugin: ReactRNPlugin, rt: any): Promise<string> {
  if (!rt) return '';
  try {
    return (await plugin.richText.toString(rt)).trim();
  } catch (_) {
    return (rt as any[]).filter((e) => typeof e === 'string').join('').trim();
  }
}

/** Wochendokumente unter TBW > Teil I > <Fachordner>, Titel endet auf „Woche N“ bzw. „Woche N)“. */
export async function wochendokumente(plugin: ReactRNPlugin) {
  const tbw = await plugin.rem.findByName(['TBW'], null);
  if (!tbw) return [];
  const docs: { remId: string; titel: string; ordner: string; woche: number; rem: any }[] = [];
  const lauf = async (rem: any, ordner: string, tiefe: number) => {
    if (tiefe > 4) return;
    for (const k of await rem.getChildrenRem()) {
      const titel = await klar(plugin, k.text);
      if (await k.isFolder()) await lauf(k, titel, tiefe + 1);
      else if (await k.isDocument()) {
        const m = titel.match(/Woche (\d+)\)?$/);
        if (m) docs.push({ remId: k._id, titel, ordner, woche: Number(m[1]), rem: k });
      }
    }
  };
  await lauf(tbw, 'TBW', 0);
  return docs;
}

function montag(t: number) {
  const d = new Date(tagesbeginn(t));
  const wt = (d.getDay() + 6) % 7; // Montag = 0
  d.setDate(d.getDate() - wt);
  return d.getTime();
}

/**
 * Zahlen eines ganzen Ordners (alle Nachkommen mit Karten), so wie RemNote sie auf der Startseite zählt.
 * faellig = Termin bis Ende heute (beim Prüfungsplaner haben auch neue Karten schon einen Termin),
 * faelligWiederholung = davon schon einmal gelernt, neuDieseWoche = erstmals gelernt seit Montag.
 */
export async function ordnerZahlen(plugin: ReactRNPlugin, name: string, jetzt = Date.now(), startNeu: number | null = null) {
  const heute0 = tagesbeginn(jetzt);
  const heuteEnde = heute0 + TAG;
  const woche0 = montag(jetzt);
  const vor30 = heute0 - 29 * TAG;
  const vorLang = heute0 - (VERLAUF_TAGE - 1) * TAG;
  const prognoseEnde = heute0 + (PROGNOSE_TAGE + 1) * TAG;
  const zugangAb = montag(jetzt) - (ZUGANG_WOCHEN - 1) * 7 * TAG;
  const ordner: any = await plugin.rem.findByName([name], null);
  if (!ordner) return null;
  const z = {
    remId: ordner._id, karten: 0, neu: 0, faellig: 0, faelligWiederholung: 0, faelligNeu: 0, heute: 0, heuteKarten: 0,
    // erledigt: heute gelernt und heute nicht noch einmal dran (so zählt RemNote „Karten übrig“ herunter, gemessen 15.11.2026)
    erledigt: 0,
    // poolNeu: neuer Prüfungsstoff, noch nie gelernt; der Prüfungsplaner parkt diese Karten auf startDateForNewlyAddedCards
    poolNeu: 0,
    heuteNeu: 0, neuDieseWoche: 0, probleme: 0,
    // aufholstapel: noch nie gelernt, laut Planer aber schon fällig (ohne den geparkten neuen Prüfungsstoff)
    aufholstapel: 0,
    verlauf: {} as Record<string, number>, // Wiederholungen je Tag, letzte 30 Tage
    bewertungen: {} as Record<string, number>, // Antworten der letzten 30 Tage nach Bewertung (score)
    verlaufLang: {} as Record<string, number>, // wie verlauf, aber bis VERLAUF_TAGE zurück
    minuten: {} as Record<string, number>, // Lernzeit je Tag in Minuten (aus den Antwortzeiten, gerundet)
    antwortzeiten: { mit: 0, ohne: 0 }, // Prüfzahl: Wiederholungen mit bzw. ohne Antwortzeit (letzte VERLAUF_TAGE)
    prognose: {} as Record<string, number>, // anstehende Wiederholungen je Tag, heute (samt überfälligen) bis +PROGNOSE_TAGE
    zugaenge: {} as Record<string, number>, // hinzugefügte Karten je Woche (Schlüssel: Montag), letzte ZUGANG_WOCHEN Wochen
    dokumente: [] as Dokument[], // Ordner und Dokumente unterhalb des Ordners mit ihren Kartensummen
  };
  for (let i = 0; i <= PROGNOSE_TAGE; i++) z.prognose[datum(heute0 + i * TAG + TAG / 2)] = 0;
  for (let i = 0; i < ZUGANG_WOCHEN; i++) z.zugaenge[datum(zugangAb + i * 7 * TAG + TAG / 2)] = 0;
  const jeRem = new Map<string, Kennzahlen>();
  const ms = {} as Record<string, number>;
  const nachfahren: any[] = await ordner.getDescendants();
  for (const r of nachfahren) {
    let karten: any[] = [];
    try {
      karten = await r.getCards();
    } catch (_) {}
    for (const c of karten) {
      const hist: any[] = (c.repetitionHistory ?? []).filter((h: any) => !h.isCram);
      z.karten++;
      // Zahlen je Rem für den Dokumentenbaum (fällig ohne geparkten neuen Prüfungsstoff, wie RemNote)
      const geparkt = hist.length === 0 && startNeu != null && c.nextRepetitionTime === startNeu;
      const e = jeRem.get(r._id) ?? leereKennzahlen();
      e.cards++;
      if (hist.length === 0) e.neu++;
      else e.learned++;
      if (!geparkt && c.nextRepetitionTime != null && c.nextRepetitionTime < heuteEnde) e.due++;
      if ((c.timesWrongInRow ?? 0) >= 2) e.struggling++;
      if (hist.length === 0 && !geparkt && c.nextRepetitionTime != null && c.nextRepetitionTime < heuteEnde) z.aufholstapel++;
      for (const h of hist) {
        if (h.date < vor30) continue;
        e.reviews30++;
        if (h.score === 0) e.again++;
        else if (h.score === 0.5) e.hard++;
        else if (h.score === 1) e.good++;
        else if (h.score === 1.5) e.easy++;
      }
      jeRem.set(r._id, e);
      // Prognose: schon gelernte Karten nach ihrem nächsten Termin (Überfälliges zählt auf heute)
      if (hist.length > 0 && c.nextRepetitionTime != null && c.nextRepetitionTime < prognoseEnde) {
        const k = datum(Math.max(c.nextRepetitionTime, heute0));
        if (k in z.prognose) z.prognose[k]++;
      }
      if (typeof c.createdAt === 'number' && c.createdAt >= zugangAb) {
        const k = datum(montag(c.createdAt) + TAG / 2);
        if (k in z.zugaenge) z.zugaenge[k]++;
      }
      const tageLang = new Set<string>();
      for (const h of hist) {
        if (h.date < vorLang) continue;
        const t = datum(h.date);
        tageLang.add(t);
        if (typeof h.responseTime === 'number' && h.responseTime > 0) {
          z.antwortzeiten.mit++;
          ms[t] = (ms[t] ?? 0) + Math.min(h.responseTime, ANTWORT_MAX_MS);
        } else z.antwortzeiten.ohne++;
      }
      for (const t of tageLang) z.verlaufLang[t] = (z.verlaufLang[t] ?? 0) + 1;
      if (hist.length === 0) z.neu++;
      if (c.nextRepetitionTime != null && c.nextRepetitionTime < heuteEnde) {
        z.faellig++;
        if (hist.length === 0) z.faelligNeu++;
        else z.faelligWiederholung++;
      }
      const heuteH = hist.filter((h) => h.date >= heute0 && h.date < heuteEnde).length;
      z.heute += heuteH;
      if (heuteH > 0) z.heuteKarten++;
      if (heuteH > 0 && (c.nextRepetitionTime == null || c.nextRepetitionTime >= heuteEnde)) z.erledigt++;
      if (hist.length === 0 && startNeu != null && c.nextRepetitionTime === startNeu) z.poolNeu++;
      // verlauf zählt gelernte Karten je Tag (jede Karte einmal je Tag), wie RemNotes Streak-Ziel „Übe heute 10 Karten“
      const tageDerKarte = new Set<string>();
      for (const h of hist) {
        if (h.date < vor30) continue;
        tageDerKarte.add(datum(h.date));
        const s = String(h.score ?? '?');
        z.bewertungen[s] = (z.bewertungen[s] ?? 0) + 1;
      }
      for (const t of tageDerKarte) z.verlauf[t] = (z.verlauf[t] ?? 0) + 1;
      if (hist.length > 0) {
        const erste = Math.min(...hist.map((h) => h.date));
        if (erste >= heute0 && erste < heuteEnde) z.heuteNeu++;
        if (erste >= woche0) z.neuDieseWoche++;
      }
      if ((c.timesWrongInRow ?? 0) >= 2) z.probleme++;
    }
  }
  for (const [t, m] of Object.entries(ms)) {
    const min = Math.round(m / 60000);
    if (min > 0) z.minuten[t] = Math.min(min, 100000);
  }
  try {
    z.dokumente = await dokumentenbaum(plugin, ordner, nachfahren, jeRem);
  } catch (_) {}
  return z;
}

export type Dokument = {
  path: string[]; name: string; remId: string; cards: number; due: number; new: number; learned: number;
  reviews30: number; struggling: number; again: number; hard: number; good: number; easy: number;
  tiefe: number; ordnung: number;
};
/** Kennzahlen je Rem bzw. Teilbaum; reviews30 und Bewertungen: Wiederholungen der letzten 30 Tage ohne Pauken. */
type Kennzahlen = {
  cards: number; due: number; neu: number; learned: number;
  reviews30: number; struggling: number; again: number; hard: number; good: number; easy: number;
};
const leereKennzahlen = (): Kennzahlen => ({ cards: 0, due: 0, neu: 0, learned: 0, reviews30: 0, struggling: 0, again: 0, hard: 0, good: 0, easy: 0 });

/**
 * Ordner und Dokumente unterhalb des Kursordners mit den Summen ihrer Karten (wie RemNotes Dokumentenstatistik).
 * Nur Ordner/Dokumente mit mindestens einer Karte, höchstens MAX_TIEFE Ebenen, Reihenfolge wie in RemNote.
 */
async function dokumentenbaum(plugin: ReactRNPlugin, ordner: any, nachfahren: any[], jeRem: Map<string, any>): Promise<Dokument[]> {
  const nachId = new Map<string, any>(nachfahren.map((r) => [r._id, r]));
  const summe = new Map<string, Kennzahlen>();
  for (const [id, e] of jeRem) {
    let x: any = nachId.get(id);
    let schritte = 0;
    while (x && schritte++ < 50) {
      const s = summe.get(x._id) ?? leereKennzahlen();
      for (const k of Object.keys(e) as (keyof Kennzahlen)[]) s[k] += e[k];
      summe.set(x._id, s);
      if (x.parent === ordner._id) break;
      x = nachId.get(x.parent);
    }
  }
  const aus: Dokument[] = [];
  let ordnung = 0;
  const lauf = async (eltern: any, pfad: string[], tiefe: number) => {
    if (tiefe > MAX_TIEFE) return;
    const kinder = ((eltern.children ?? []) as string[]).map((id) => nachId.get(id)).filter(Boolean);
    for (const k of kinder) {
      const s = summe.get(k._id);
      if (!s || s.cards === 0 || !(k.children ?? []).length) continue;
      if (!(await k.isFolder()) && !(await k.isDocument())) continue;
      if (!/^[A-Za-z0-9]{1,40}$/.test(k._id)) continue;
      const name = ((await klar(plugin, k.text)) || '(ohne Titel)').slice(0, 80);
      aus.push({
        path: pfad, name, remId: k._id, cards: s.cards, due: s.due, new: s.neu, learned: s.learned,
        reviews30: s.reviews30, struggling: s.struggling, again: s.again, hard: s.hard, good: s.good, easy: s.easy,
        tiefe, ordnung: ordnung++,
      });
      if (pfad.length + 1 < MAX_TIEFE) await lauf(k, [...pfad, name], tiefe + 1);
    }
  };
  await lauf(ordner, [], 1);
  return aus;
}

/**
 * Tagesziel des RemNote-Prüfungsplaners (Powerup „de“, Slot ExamConfig am Ordner).
 * In der Aufholphase gilt catchUpPeriod.dailyGoalMin, sonst dailyGoalRangeMin.
 * Neue Karten: learningPlan.cardsPerWeek für die laufende Woche (ab Montag).
 * RemNote rechnet das intern; die Formel ist an der Anzeige nachgemessen (15.11.2026: Ziel 89, neu 2).
 */
export async function pruefungsplan(plugin: ReactRNPlugin, remId: string, jetzt = Date.now()) {
  try {
    const rem: any = await plugin.rem.findOne(remId);
    if (!rem || !(await rem.hasPowerup('de'))) return null;
    const roh = await rem.getPowerupProperty('de', 'ExamConfig');
    if (!roh) return null;
    const cfg = JSON.parse(typeof roh === 'string' ? roh : String(roh));
    let ziel: number | null = cfg.dailyGoalRangeMin ?? null;
    let aufholen = false;
    const ch = cfg.catchUpPeriod;
    if (ch?.untilDateString && tagesbeginn(jetzt) <= tagesbeginn(Date.parse(ch.untilDateString))) {
      ziel = ch.dailyGoalMin ?? ziel;
      aufholen = true;
    }
    const neuWoche = cfg.learningPlan?.cardsPerWeek?.[datum(montag(jetzt))] ?? null;
    let startNeu: number | null = null;
    try {
      const info = await rem.getPowerupProperty('de', 'SavedExamInfo');
      if (info) startNeu = JSON.parse(String(info)).startDateForNewlyAddedCards ?? null;
    } catch (_) {}
    return {
      ziel, neuWoche, aufholen, startNeu,
      pruefung: cfg.examDate ?? null,
      neuJeWoche: (cfg.learningPlan?.cardsPerWeek ?? {}) as Record<string, number>,
      aufholenBis: ch?.untilDateString ? datum(Date.parse(ch.untilDateString)) : null,
      zielSpanne: aufholen ? [ch.dailyGoalMin, ch.dailyGoalMax] : [cfg.dailyGoalRangeMin, cfg.dailyGoalRangeMax],
    };
  } catch (_) {
    return null;
  }
}

/**
 * Fortschritt je Fach: Unterordner bzw. Dokumente direkt unter dem Fachstamm
 * (TBW: „Teil I - …“ falls vorhanden, Studium: der Ordner selbst).
 * gelernt = Karte mindestens einmal wiederholt, faellig = Termin bis Ende heute.
 */
export async function fachZahlen(plugin: ReactRNPlugin, ordnerName: string, jetzt = Date.now(), startNeu: number | null = null) {
  const heuteEnde = tagesbeginn(jetzt) + TAG;
  const ordner: any = await plugin.rem.findByName([ordnerName], null);
  if (!ordner) return [];
  // TBW ist in „Teil I/II/III - …“ gegliedert; die Fächer liegen darunter. Ohne Teile sind die Kinder selbst die Fächer.
  const teile: any[] = [];
  for (const k of await ordner.getChildrenRem()) if (/^Teil /.test(await klar(plugin, k.text))) teile.push(k);
  const kandidaten: any[] = [];
  for (const s of teile.length ? teile : [ordner]) kandidaten.push(...(await s.getChildrenRem()));
  const faecher: { name: string; cards: number; learned: number; due: number }[] = [];
  for (const f of kandidaten) {
    if (!(await f.isFolder()) && !(await f.isDocument())) continue;
    const z = { name: (await klar(plugin, f.text)).slice(0, 80), cards: 0, learned: 0, due: 0 };
    for (const r of [f, ...(await f.getDescendants())]) {
      let karten: any[] = [];
      try {
        karten = await r.getCards();
      } catch (_) {}
      for (const c of karten) {
        z.cards++;
        if ((c.repetitionHistory ?? []).some((h: any) => !h.isCram)) z.learned++;
        // geparkter neuer Prüfungsstoff zählt wie bei RemNote nicht als fällig, sondern als „zu lernen“
        const geparkt = startNeu != null && c.nextRepetitionTime === startNeu && !(c.repetitionHistory ?? []).length;
        if (!geparkt && c.nextRepetitionTime != null && c.nextRepetitionTime < heuteEnde) z.due++;
      }
    }
    if (z.cards > 0) faecher.push(z);
  }
  return faecher;
}

export async function tageszahlen(plugin: ReactRNPlugin, jetzt = Date.now()) {
  const heute0 = tagesbeginn(jetzt);
  const heuteEnde = heute0 + TAG;
  const gesamt = { faellig: 0, neu: 0, heute: 0, probleme: 0, karten: 0 };
  const proTag: Record<string, number> = {};
  let naechste: number | null = null;
  const wochen: any[] = [];
  for (const d of await wochendokumente(plugin)) {
    const w = { remId: d.remId, titel: d.titel, ordner: d.ordner, woche: d.woche, karten: 0, faellig: 0, neu: 0, heute: 0, probleme: 0 };
    for (const r of await d.rem.getChildrenRem()) {
      let karten: any[] = [];
      try {
        karten = await r.getCards();
      } catch (_) {}
      for (const c of karten) {
        const hist: any[] = c.repetitionHistory ?? [];
        w.karten++;
        if (hist.length === 0) w.neu++;
        else if (c.nextRepetitionTime != null && c.nextRepetitionTime < heuteEnde) w.faellig++;
        w.heute += hist.filter((h) => h.date >= heute0 && h.date < heuteEnde && !h.isCram).length;
        if ((c.timesWrongInRow ?? 0) >= 2) w.probleme++;
        if (hist.length > 0 && c.nextRepetitionTime != null) {
          if (c.nextRepetitionTime >= heuteEnde && c.nextRepetitionTime < heute0 + 15 * TAG) {
            const k = datum(c.nextRepetitionTime);
            proTag[k] = (proTag[k] ?? 0) + 1;
          }
          if (c.nextRepetitionTime > jetzt && (naechste === null || c.nextRepetitionTime < naechste)) naechste = c.nextRepetitionTime;
        }
      }
    }
    for (const k of ['karten', 'faellig', 'neu', 'heute', 'probleme'] as const) gesamt[k] += w[k];
    wochen.push(w);
  }
  const tbwRem: any = await plugin.rem.findByName(['TBW'], null);
  const plan = tbwRem ? await pruefungsplan(plugin, tbwRem._id, jetzt) : null;
  const tbw = await ordnerZahlen(plugin, 'TBW', jetzt, plan?.startNeu ?? null);
  // Startwerte des Tages festhalten (Startwert je Tag, damit der Fortschrittsbalken einen festen Bezug hat).
  // Ziel und Pool des neuen Stoffs gelten ab dem ersten Zählen des Tages unverändert.
  let tagesstart: any = null;
  try {
    const heute = datum(jetzt);
    tagesstart = await plugin.storage.getLocal('tagesstart');
    if (!tagesstart || tagesstart.datum !== heute) {
      tagesstart = { datum: heute, ziel: plan?.ziel ?? null, poolNeu: tbw?.poolNeu ?? 0, neuQuote: plan?.neuWoche ?? 0 };
      await plugin.storage.setLocal('tagesstart', tagesstart);
    }
  } catch (_) {}
  let studium = null;
  try {
    studium = await ordnerZahlen(plugin, 'Studium', jetzt); // nur lesend (Berechtigung Read)
  } catch (_) {}
  // Tagesziel-Verlauf: je Tag Ziel und erledigt festhalten (ab 16.11.2026; ältere Tage kennt das Plugin nicht).
  let zielverlauf: Record<string, { goal: number; done: number }> = {};
  try {
    zielverlauf = ((await plugin.storage.getLocal('zielverlauf')) as any) ?? {};
    if (tagesstart?.ziel != null && tbw) zielverlauf[datum(jetzt)] = { goal: tagesstart.ziel, done: tbw.erledigt };
    const tage = Object.keys(zielverlauf).sort();
    for (const t of tage.slice(0, Math.max(0, tage.length - 60))) delete zielverlauf[t];
    await plugin.storage.setLocal('zielverlauf', zielverlauf);
  } catch (_) {}
  let faecher: any[] = [];
  try {
    faecher = [
      ...(await fachZahlen(plugin, 'TBW', jetzt, plan?.startNeu ?? null)).map((f) => ({ course: 'TBW', ...f })),
      ...(await fachZahlen(plugin, 'Studium', jetzt)).map((f) => ({ course: 'WiING', ...f })),
    ];
  } catch (_) {}
  return {
    erfasst: new Date(jetzt).toISOString(),
    tbw,
    plan,
    tagesstart,
    zielverlauf,
    faecher,
    studium,
    gesamt,
    faelligJeTag: proTag,
    naechsteFaelligkeit: naechste ? new Date(naechste).toISOString() : null,
    wochen,
  };
}
