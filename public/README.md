# RemNote-Karten TBW

Kleines RemNote-Plugin für Lernkarten unterhalb eines Ordners „TBW“.

- Schreibt und liest Lernkarten unterhalb von „TBW“ im Auftrag eines lokalen Kartenwerkzeugs. Das passiert nur, wenn dessen Brücke auf diesem Rechner unter localhost:8080 läuft; sonst ruht dieser Teil.
- Zählt fällige, neue und gelernte Karten je Ordner und Dokument, dazu Lernstatistik (Wiederholungen je Tag, Lernminuten aus den Antwortzeiten, Antworten nach Bewertung, anstehende Karten der nächsten 30 Tage, hinzugefügte Karten je Woche). Die Zahlen gehen an einen eigenen Server, sobald Adresse und Zugangstoken in den Plugin-Einstellungen eingetragen sind. Gesendet wird beim Start, nach jeder Abfrage, alle 15 Minuten oder über den Befehl „Lernzentrale: Lernkarten-Zahlen jetzt senden“.
- Läuft auch auf iPhone, iPad und Android, dort nur zum Zählen und Senden; der Kartenwerkzeug-Teil (localhost) ist auf Mobilgeräten abgeschaltet. Startwert und Zielverlauf des Tages liegen im synchronisierten Plugin-Speicher, damit alle Geräte denselben Bezug haben.
Berechtigung: Rems unterhalb von „TBW“ (lesen und schreiben) und unterhalb von „Studium“ (nur lesen, nur zum Zählen). Adresse und Token stehen nie im Quelltext. Der Schalter „langen Lernverlauf senden“ erweitert den Verlauf von 30 auf 400 Tage (Standard aus).

## Datenschutz / Privacy

- Das Plugin sendet nur Zählwerte: Anzahl der Karten, fällige, neue, gelernte und Problemkarten je Ordner und Dokument, Wiederholungen und Lernminuten je Tag, Antworten nach Bewertung, anstehende und hinzugefügte Karten, das Prüfungsdatum des Prüfungsplaners, außerdem Titel und Kennung der Ordner und Dokumente. Karteninhalte werden nicht gesendet.
- Empfänger ist allein der Server, den die Nutzerin oder der Nutzer selbst in den Plugin-Einstellungen einträgt. Ohne Eintrag wird nichts gesendet. Es gibt keine Analyse und keine Übermittlung an Dritte.
- Der Kartenwerkzeug-Teil spricht nur mit `localhost` auf dem eigenen Rechner.
The plugin only sends counts (cards, due, new, learned and struggling per folder and document, reviews and study minutes per day, answers by rating, upcoming and added cards, the exam date of the exam scheduler, plus folder and document titles and IDs), never card content. They go only to a server the user enters in the plugin settings; nothing is sent without it. There is no analytics and no third-party transfer. The local tool part talks to `localhost` only.

Bauen: `npm install`, dann `node build.mjs`. Das ergibt `dist/` und `PluginZip.zip`.
