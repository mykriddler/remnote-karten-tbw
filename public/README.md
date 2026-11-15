# RemNote-Karten TBW

Kleines RemNote-Plugin für Lernkarten unterhalb eines Ordners „TBW“.

- Schreibt und liest Lernkarten unterhalb von „TBW“ im Auftrag eines lokalen Kartenwerkzeugs. Das passiert nur, wenn dessen Brücke auf diesem Rechner unter localhost:8080 läuft; sonst ruht dieser Teil.
- Zählt je Wochendokument fällige, neue und heute gelernte Karten. Die Zahlen gehen an einen eigenen Server, sobald Adresse und Zugangstoken in den Plugin-Einstellungen eingetragen sind. Gesendet wird beim Start, nach jeder Abfrage, alle 15 Minuten oder über den Befehl „Lernzentrale: Lernkarten-Zahlen jetzt senden“.

Berechtigung: Rems unterhalb von „TBW“ (lesen und schreiben) und unterhalb von „Studium“ (nur lesen, nur zum Zählen). Adresse und Token stehen nie im Quelltext.

## Datenschutz / Privacy

- Das Plugin sendet nur Zählwerte: Anzahl der Karten, fällige, neue, heute gelernte und Problemkarten je Wochendokument, außerdem Titel und Kennung dieser Wochendokumente. Karteninhalte werden nicht gesendet.
- Empfänger ist allein der Server, den die Nutzerin oder der Nutzer selbst in den Plugin-Einstellungen einträgt. Ohne Eintrag wird nichts gesendet. Es gibt keine Analyse und keine Übermittlung an Dritte.
- Der Kartenwerkzeug-Teil spricht nur mit `localhost` auf dem eigenen Rechner.

The plugin only sends counts (cards, due, new, reviewed today, struggling per weekly document, plus their titles and IDs), never card content. They go only to a server the user enters in the plugin settings; nothing is sent without it. There is no analytics and no third-party transfer. The local tool part talks to `localhost` only.

Bauen: `npm install`, dann `node build.mjs`. Das ergibt `dist/` und `PluginZip.zip`.
