// RemNote-Karten: Plugin als schlanker Ausführer.
// Holt Aufträge von der lokalen Brücke (nur 127.0.0.1, nur während eines Laufs aktiv),
// führt sie über die offizielle Plugin-Schnittstelle aus und meldet das Ergebnis zurück.
// Die Logik (was geschrieben wird) liegt im Werkzeug, nicht hier.
import { declareIndexPlugin, type ReactRNPlugin, type RichTextInterface } from '@remnote/plugin-sdk';
import { tageszahlen } from './tageszahlen';
import { einrichten, beenden, sendeJetzt, status, nutzlast, langerVerlauf } from './senden';

const BRUECKE = 'http://localhost:8080/bruecke';
const VERSION = '0.3.4';
const POWERUPS = ['w', 'o', 'u', 'r', 'dv', 'f', 'id', 'n', 'pn', 'i', 'qt', 'cd', 'x'];

let aktiv = true;

function warte(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function klartext(plugin: ReactRNPlugin, rt: any): Promise<string> {
  if (!rt) return '';
  try {
    return await plugin.richText.toString(rt);
  } catch (_) {
    // Fallback: Elemente selbst zusammensetzen (Bilder, Verweise, Formeln)
    const teile: string[] = [];
    for (const e of rt as any[]) {
      if (typeof e === 'string') teile.push(e);
      else if (e && typeof e.text === 'string') teile.push(e.text);
      else if (e && e.i === 'q') teile.push('[Verweis]');
      else if (e && e.i === 'i') teile.push('[Bild]');
      else teile.push('[' + String(e?.i ?? '?') + ']');
    }
    return teile.join('');
  }
}

async function remDaten(plugin: ReactRNPlugin, rem: any, tiefe: number, mitKarten: boolean): Promise<any> {
  const pu: string[] = [];
  for (const code of POWERUPS) {
    try {
      if (await rem.hasPowerup(code)) pu.push(code);
    } catch (_) {}
  }
  const d: any = {
    id: rem._id,
    parent: rem.parent,
    text: rem.text ?? null,
    backText: rem.backText ?? null,
    textPlain: await klartext(plugin, rem.text),
    backPlain: rem.backText ? await klartext(plugin, rem.backText) : null,
    type: rem.type,
    isFolder: await rem.isFolder(),
    isDocument: await rem.isDocument(),
    isCardItem: await rem.isCardItem(),
    practiceDirection: await rem.getPracticeDirection(),
    enablePractice: await rem.getEnablePractice(),
    powerups: pu,
    childCount: (rem.children ?? []).length,
  };
  if (mitKarten) {
    try {
      const cards = await rem.getCards();
      d.cards = cards.map((c: any) => ({
        id: c._id,
        type: c.type,
        next: c.nextRepetitionTime ?? null,
        reps: (c.repetitionHistory ?? []).length,
      }));
    } catch (e) {
      d.cards = 'fehler: ' + String(e);
    }
  }
  if (tiefe > 0) {
    const kinder = await rem.getChildrenRem();
    // Reihenfolge wie in RemNote: nach children-Liste des Elternteils
    const ordnung = rem.children ?? [];
    kinder.sort((a: any, b: any) => ordnung.indexOf(a._id) - ordnung.indexOf(b._id));
    d.kinder = [];
    for (const k of kinder) d.kinder.push(await remDaten(plugin, k, tiefe - 1, mitKarten));
  }
  return d;
}

async function holeRem(plugin: ReactRNPlugin, id: string) {
  const rem = await plugin.rem.findOne(id);
  if (!rem) throw new Error('Rem nicht gefunden oder außerhalb der Berechtigung: ' + id);
  return rem;
}

function rt(text: string): RichTextInterface {
  return [text];
}

async function fuehreAus(plugin: ReactRNPlugin, op: string, a: any): Promise<any> {
  switch (op) {
    case 'ping':
      return { version: VERSION, zeit: Date.now(), mobil: await aufMobilgeraet(plugin) };
    case 'findeOben': {
      const rem = await plugin.rem.findByName(rt(a.name), null);
      return rem ? rem._id : null;
    }
    case 'findeKind': {
      const rem = await plugin.rem.findByName(rt(a.name), a.parentId);
      return rem ? rem._id : null;
    }
    case 'lies': {
      const rem = await holeRem(plugin, a.id);
      return await remDaten(plugin, rem, a.tiefe ?? 0, !!a.karten);
    }
    case 'erzeuge': {
      // a: {parentId, position?, text, backText?, kartenzeile?, dokument?, ordner?, powerups?, richtung?}
      const rem = await plugin.rem.createRem();
      if (!rem) throw new Error('createRem lieferte nichts');
      await rem.setText(rt(a.text ?? ''));
      if (a.backText !== undefined && a.backText !== null) await rem.setBackText(rt(a.backText));
      if (a.position === undefined || a.position === null) await rem.setParent(a.parentId);
      else await rem.setParent(a.parentId, a.position);
      if (a.dokument) await rem.setIsDocument(true);
      if (a.ordner) await rem.setIsFolder(true);
      for (const p of a.powerups ?? []) await rem.addPowerup(p);
      if (a.kartenzeile) await rem.setIsCardItem(true);
      if (a.richtung) await rem.setPracticeDirection(a.richtung);
      return rem._id;
    }
    case 'karte': {
      // Eine mehrzeilige Karte: Frage-Rem plus Antwortzeilen als Kinder. Alles in einem Auftrag,
      // damit eine Karte nie halb entsteht.
      const opts = a.form ?? {};
      const frage = await plugin.rem.createRem();
      if (!frage) throw new Error('createRem lieferte nichts');
      await frage.setText(rt(a.frage));
      if (opts.backText !== undefined) await frage.setBackText(opts.backText === null ? undefined : rt(opts.backText));
      if (a.position === undefined || a.position === null) await frage.setParent(a.parentId);
      else await frage.setParent(a.parentId, a.position);
      for (const p of opts.powerups ?? []) await frage.addPowerup(p);
      const ids: string[] = [];
      for (const zeile of a.antworten as string[]) {
        const k = await plugin.rem.createRem();
        if (!k) throw new Error('createRem lieferte nichts (Antwortzeile)');
        await k.setText(rt(zeile));
        await k.setParent(frage._id);
        if (opts.kartenzeile !== false) await k.setIsCardItem(true);
        ids.push(k._id);
      }
      if (opts.richtung) await frage.setPracticeDirection(opts.richtung);
      return { id: frage._id, antworten: ids };
    }
    case 'entferne': {
      const rem = await holeRem(plugin, a.id);
      await rem.remove();
      return true;
    }
    case 'setzeText': {
      const rem = await holeRem(plugin, a.id);
      await rem.setText(rt(a.text));
      return true;
    }
    case 'verschiebe': {
      await plugin.rem.moveRems([a.id], a.parentId, a.position);
      return true;
    }
    case 'eigenschaften': {
      // Powerups, Slots und Tags eines Rems lesen (etwa die Lernpriorität am Dokument)
      const rem: any = await holeRem(plugin, a.id);
      const codes: string[] = a.codes ?? [];
      const erg: any = { powerups: {}, tags: [] };
      for (const code of codes) {
        let hat = false;
        try {
          hat = await rem.hasPowerup(code);
        } catch (_) {}
        if (!hat) continue;
        erg.powerups[code] = {};
        for (const slot of a.slots?.[code] ?? []) {
          try {
            const roh = await rem.getPowerupProperty(code, slot);
            erg.powerups[code][slot] = roh;
          } catch (e) {
            erg.powerups[code][slot] = 'fehler: ' + String(e);
          }
        }
      }
      try {
        for (const t of await rem.getTagRems()) erg.tags.push({ id: t._id, text: await klartext(plugin, t.text) });
      } catch (_) {}
      return erg;
    }
    case 'fensterUrl':
      // aktuelle Adresse der RemNote-Oberfläche (für Sprunglinks)
      return await plugin.window.getURL();
    case 'oeffne': {
      const rem = await holeRem(plugin, a.id);
      await plugin.window.openRem(rem);
      return await plugin.window.getURL();
    }
    case 'tageszahlen':
      return await tageszahlen(plugin);
    case 'syncVorschau':
      return nutzlast(await tageszahlen(plugin), a?.langerVerlauf ?? (await langerVerlauf(plugin)));
    case 'syncJetzt':
      return await sendeJetzt(plugin, 'über die Brücke');
    case 'syncStatus':
      return status();
    case 'neuLaden':
      // Plugin-Rahmen neu laden (holt den frischen Bau von der Bruecke), damit nach einem Bau kein Umschalten von Hand noetig ist
      setTimeout(() => (globalThis as any).location?.reload(), 200);
      return true;
    case 'herkunft':
      // Adresse, unter der das Plugin läuft (für die CORS-Freigabe der Lernzentrale)
      return { origin: (globalThis as any).location?.origin ?? null, href: (globalThis as any).location?.href ?? null, version: VERSION };
    case 'wissensbasis':
      return await plugin.kb.getCurrentKnowledgeBaseData();
    case 'setzeEigenschaft': {
      // Powerup hinzufügen und einen Slot setzen (Wert als Klartext)
      const rem: any = await holeRem(plugin, a.id);
      if (!(await rem.hasPowerup(a.code))) await rem.addPowerup(a.code);
      if (a.slot) await rem.setPowerupProperty(a.code, a.slot, rt(a.wert));
      return true;
    }
    default:
      throw new Error('unbekannter Auftrag: ' + op);
  }
}

async function schleife(plugin: ReactRNPlugin) {
  let fehlversuche = 0;
  while (aktiv) {
    try {
      const r = await fetch(BRUECKE + '/naechster', { cache: 'no-store' });
      fehlversuche = 0;
      if (r.status === 204) continue; // nichts zu tun, sofort neu fragen (Brücke hält die Anfrage offen)
      if (!r.ok) {
        await warte(3000);
        continue;
      }
      const auftrag = await r.json();
      const ergebnisse: any[] = [];
      for (const schritt of auftrag.schritte) {
        try {
          ergebnisse.push({ ok: true, wert: await fuehreAus(plugin, schritt.op, schritt.args ?? {}) });
        } catch (e: any) {
          ergebnisse.push({ ok: false, fehler: String(e?.message ?? e) });
          if (auftrag.abbrechenBeiFehler !== false) break;
        }
      }
      await fetch(BRUECKE + '/ergebnis', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ id: auftrag.id, ergebnisse }),
      });
    } catch (_) {
      // Brücke läuft nicht: ruhig warten, langsam seltener fragen.
      fehlversuche++;
      await warte(Math.min(60000, 3000 * fehlversuche));
    }
  }
}

/** iPhone, iPad und Android: dort gibt es keine Brücke, das Plugin sendet nur die Tageszahlen. */
async function aufMobilgeraet(plugin: ReactRNPlugin) {
  try {
    const os = await plugin.app.getOperatingSystem();
    return os === 'ios' || os === 'android';
  } catch (_) {
    return false;
  }
}

async function onActivate(plugin: ReactRNPlugin) {
  aktiv = true;
  // Tageszahlen an die Lernzentrale (Einstellungen, Befehl, Auslöser), auf allen Geräten
  await einrichten(plugin);
  // Kartenwerkzeug: Aufträge der lokalen Brücke (nur am Rechner; dort nur aktiv, wenn die Brücke läuft).
  // Auf Mobilgeräten gar nicht erst nach der Brücke fragen (spart Akku und Netz).
  if (!(await aufMobilgeraet(plugin))) schleife(plugin);
}

async function onDeactivate(_: ReactRNPlugin) {
  aktiv = false;
  beenden();
}

declareIndexPlugin(onActivate, onDeactivate);
