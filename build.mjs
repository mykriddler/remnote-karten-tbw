// Baut das Plugin nach dist/ im selben Aufbau wie die offizielle Vorlage
// (index.html lädt <widget>-sandbox.js; <widget>.js für den nativen Modus).
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
const gemeinsam = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};
await build({ ...gemeinsam, outfile: 'dist/index-sandbox.js' });
await build({ ...gemeinsam, outfile: 'dist/index.js', banner: { js: 'const IMPORT_META=import.meta;' } });
writeFileSync(
  'dist/index.html',
  `<body></body>
<script type="text/javascript">
const p = Object.fromEntries(new URLSearchParams(window.location.search).entries());
const w = p["widgetName"];
if (w == undefined) { document.body.innerHTML += "Widget ID not specified."; }
const s = document.createElement('script'); s.type = "module"; s.src = w + "-sandbox.js"; document.body.appendChild(s);
</script>
`,
);
cpSync('public', 'dist', { recursive: true });
console.log('Plugin gebaut: dist/');

// Paket für RemNote > Einstellungen > Plugins > Entwickeln > „Plugin hochladen“ (dauerhafte Installation)
import { execFileSync } from 'node:child_process';
rmSync('PluginZip.zip', { force: true });
// Windows-tar (bsdtar) schreibt Zip-Einträge mit / und ohne Ordnerpräfix; Compress-Archive tut das nicht
execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', 'PluginZip.zip', '-C', 'dist', 'index.html', 'index.js', 'index-sandbox.js', 'manifest.json', 'README.md']);
console.log('Paket: PluginZip.zip');
