'use strict';
// End-to-End-Test: Console + Controller im echten Chromium gegen den Dev-Stack.
// Start:  NODE_PATH=$(npm root -g) node e2e/e2e.cjs
// Voraussetzung: docker compose -f compose.yaml -f compose.dev.yaml up -d
//
// ponytail: kein Test-Framework, keine Fixtures – ein Skript, Schritte der Reihe
// nach, der erste Fehlschlag beendet den Lauf. Jeder Schritt hat ein eigenes
// Timeout; bei Fehlschlag werden die Browser-Console-Meldungen beider Seiten
// ausgegeben. Exit-Code != 0 bei Fehlschlag.

const { chromium } = require('playwright');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'https://localhost';
const ROOT = path.join(__dirname, '..');
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{5}$/;
const COMPOSE = 'docker compose -f compose.yaml -f compose.dev.yaml';
// Das Spiel liegt in out/schnittfest.js (Plan 02, Schritt 1). Fehlt es noch, werden die
// Spiel-Schritte uebersprungen statt zu scheitern.
const HAS_GAME = fs.existsSync(path.join(ROOT, 'out', 'schnittfest.js'));
// Dasselbe fuer Fruit Ninja (Plan 03, Schritt 2).
const HAS_FN = fs.existsSync(path.join(ROOT, 'out', 'fruitninja.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const logs = [];                       // Browser-Console beider Seiten
const results = [];                    // [status, name, ms, note]

function watch(page, tag) {
  page.on('console', m => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${tag}] ${t}: ${m.text()}`);
  });
  page.on('pageerror', e => logs.push(`[${tag}] pageerror: ${e.message}`));
  return page;
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: Timeout nach ${ms} ms`)), ms); }),
  ]);
}

async function step(name, ms, fn) {
  const t0 = Date.now();
  try {
    const note = await withTimeout(fn(), ms, name);
    results.push(['ok', name, Date.now() - t0, note || '']);
    console.log(`ok    ${pad(name)} ${ms_(Date.now() - t0)}${note ? '  ' + note : ''}`);
  } catch (e) {
    results.push(['FAIL', name, Date.now() - t0, e.message]);
    console.log(`FAIL  ${pad(name)} ${ms_(Date.now() - t0)}  ${e.message}`);
    e.reported = true;
    throw e;
  }
}
function skip(name, why) {
  results.push(['skip', name, 0, why]);
  console.log(`skip  ${pad(name)}         ${why}`);
}
const pad = s => (s + ' ').padEnd(50, '.');
const ms_ = n => String(n + ' ms').padStart(8);

// --- Hilfen -----------------------------------------------------------------
const seqOf = (page, slot) => page.evaluate(s => (window.__wii && window.__wii.seq[s]) | 0, slot);
const txt = async (page, sel) => ((await page.textContent(sel)) || '').trim();

// Wartet, bis sich seq[slot] nachweislich aendert (0 = kein Frame; nach einem
// Neuaufbau setzt die Console den Slot auf 0 zurueck, deshalb 0 nie als Treffer).
async function waitFlow(page, slot, ms, label) {
  const end = Date.now() + ms;
  let a = await seqOf(page, slot);
  while (Date.now() < end) {
    await sleep(200);
    const b = await seqOf(page, slot);
    if (b !== 0 && b !== a) return `seq ${a} -> ${b}`;
    a = b;
  }
  throw new Error(`${label}: seq[${slot}] bewegt sich nicht binnen ${ms} ms (zuletzt ${a})`);
}

// Der Controller ist ein Hochkant-Layout: im Querformat legt sich ein Overlay
// ueber Code-Eingabe und Tasten. Headless startet mit 1280x720, also Portrait setzen.
const PORTRAIT = { width: 390, height: 844 };

// Nach jedem join/resume verlangt der Controller eine Kalibrierung, vorher fliesst nichts.
async function calibrate(p) {
  await waitFor(() => p.isVisible('#calbtn'), 8000, 'Kalibrier-Schritt sichtbar');
  await p.click('#calbtn');
}
// Beweist die Gegenprobe zu waitFlow: solange nicht kalibriert ist, bleibt seq[slot] auf 0.
async function quiet(page, slot, ms, label) {
  const end = Date.now() + ms;
  do {
    const v = await seqOf(page, slot);
    if (v !== 0) throw new Error(`${label}: seq[${slot}] = ${v}, obwohl noch nicht kalibriert`);
    await sleep(100);
  } while (Date.now() < end);
}

// Die Phase `cut` dauert nur 2 s – enger pollen als waitFor (200 ms).
async function waitCut(page, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const d = await page.evaluate(() => window.Schnittfest.debug());
    if (d && d.phase === 'cut') return d;
    if (Date.now() >= end) throw new Error(`Phase cut: nicht erreicht binnen ${ms} ms`);
    await sleep(50);
  }
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) throw new Error(`${label}: nicht erfuellt binnen ${ms} ms`);
    await sleep(200);
  }
}

(async () => {
  const t0 = Date.now();
  // Fruit Ninja rendert mit WebGL; headless gibt es GPU nur als Software-Renderer.
  // Reicht das nicht ("Error creating WebGL context"), zusaetzlich '--use-angle=swiftshader'.
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  let ok = true;
  let con = null, ctrl = null, code = null, gcon = null, gctrl = null, fcon = null, fctrl = null;
  let gws = null, gwsN = 0;              // geroutete Signaling-Verbindung des Spiel-Controllers

  // Console-Tab oeffnen und Raum erstellen. Ohne ?debug liegt der Start-Screen ueber
  // Slot-Tabelle und Beispiel-Buttons – die Schritte 1-12 brauchen also die Debug-Seite,
  // der Spiel-Block (13-16) bewusst die echte Ansicht.
  async function openConsole(tag, query) {
    const p = watch(await ctx.newPage(), tag);
    await p.goto(`${BASE}/?${query || 'debug'}`, { waitUntil: 'domcontentloaded' });
    await p.click(query ? '#startbtn' : '#create');       // ohne Raum legt „Start“ ihn an
    code = await waitFor(async () => {
      const t = await txt(p, '#code');
      return CODE_RE.test(t) ? t : null;
    }, 15000, 'Raum-Code');
    return p;
  }
  // Controller-Tab oeffnen und beitreten; liefert die belegte Slot-Nummer
  async function joinController(tag, query) {
    const p = watch(await ctx.newPage(), tag);
    await p.setViewportSize(PORTRAIT);
    await p.goto(`${BASE}/controller?room=${code}${query ? '&' + query : ''}`, { waitUntil: 'domcontentloaded' });
    await p.click('#start');
    const st = await waitFor(async () => {
      const m = /Slot (\d)/.exec(await txt(p, '#state'));
      return m ? m : null;
    }, 15000, `${tag} joined`);
    return { page: p, slot: Number(st[1]), state: st.input.trim() };
  }

  // Zeiger per hold-Winkeln auf ein Element legen und mit Taste A klicken – Umkehrung
  // der Strahlprojektion wie in Schritt 5. Jede neue Zielrichtung braucht einen Reload.
  async function aimClick(con, ctrl, sel, label) {
    const a = await con.evaluate(s => {
      const r = document.querySelector(s).getBoundingClientRect();
      const W = innerWidth, H = innerHeight, D = 0.87 * W, deg = v => v * 180 / Math.PI;
      const az = Math.atan((r.left + r.width / 2 - W / 2) / D);
      return { a: -deg(az), b: deg(Math.atan((H / 2 - r.top - r.height / 2) * Math.cos(az) / D)) };
    }, sel);
    await ctrl.goto(`${BASE}/controller?room=${code}&fake=1&hold=${a.a.toFixed(3)},${a.b.toFixed(3)}`,
                    { waitUntil: 'domcontentloaded' });
    await ctrl.click('#start');
    await waitFor(async () => /Slot 0/.test(await txt(ctrl, '#state')), 15000, 'resume auf Slot 0');
    await calibrate(ctrl);
    await waitFlow(con, 0, 15000, `Frames mit Ziel ${label}`);
    await sleep(300);                                       // Glättung (0.5/Frame) einschwingen lassen
    await waitFor(() => con.evaluate(s => document.querySelector(s).classList.contains('wii-hover'), sel),
                  8000, `${label} bekommt wii-hover`);
    await ctrl.click('.k[data-id="0"]');                    // Taste A = Klick unter dem Zeiger
  }
  const shown = (page, id) => page.evaluate(i => !document.getElementById(i).hidden, id);

  try {
    await step('1 Raum erstellen, Code aus dem DOM', 20000, async () => {
      con = await openConsole('console');
      return `room ${code}`;
    });

    // Der Raum-Code wird mit der nativen Tastatur getippt: kein readonly, keine
    // Bildschirm-Tastatur. Enter/Go startet, damit die Tastatur den Button nicht verdeckt.
    await step('1b Raum-Code nativ tippen', 20000, async () => {
      const p = watch(await ctx.newPage(), 'controller-keys');
      await p.setViewportSize(PORTRAIT);
      await p.goto(`${BASE}/controller`, { waitUntil: 'domcontentloaded' });
      try {
        if (await p.evaluate(() => document.getElementById('code').readOnly))
          throw new Error('#code ist readonly – die native Tastatur kommt nicht dran');
        await p.click('#code');
        await p.keyboard.type(code.toLowerCase() + 'XX');            // klein + zwei zu viel
        let v = await p.inputValue('#code');
        if (v.toUpperCase() !== code) throw new Error(`#code = "${v}" statt "${code}" (maxlength 5?)`);
        await p.keyboard.press('Backspace');
        v = await p.inputValue('#code');
        if (v.toUpperCase() !== code.slice(0, -1)) throw new Error(`nach Backspace "${v}" statt "${code.slice(0, -1)}"`);
        // 4 Zeichen sind ungueltig: Enter loest den Start-Handler aus, ohne einen Slot zu belegen
        await p.keyboard.press('Enter');
        await p.waitForFunction(() => /Raum-Code/.test(document.getElementById('hint').textContent),
          null, { timeout: 5000 });
      } finally { await p.close(); }
      return `nativ getippt, maxlength 5, Backspace, Enter startet`;
    });

    await step('2 Controller joint (fake=1&hold) + Kalibrierung', 20000, async () => {
      ctrl = await joinController('controller', 'fake=1&hold=0,0');
      if (ctrl.slot !== 0) throw new Error(`Slot ${ctrl.slot} statt 0`);
      await quiet(con, 0, 500, 'vor der Kalibrierung');      // erst der Klick macht den Kanal auf
      await calibrate(ctrl.page);
      return `${ctrl.state}, kalibriert`;
    });

    await step('3 Sensor-Frames >= 30/s auf der Console', 25000, async () => {
      await waitFlow(con, 0, 20000, 'erste Frames');
      const a = await seqOf(con, 0), ta = Date.now();
      await sleep(2000);
      const b = await seqOf(con, 0), dt = (Date.now() - ta) / 1000;
      const rate = ((b - a) & 0xffff) / dt;
      const st = await con.evaluate(() => {
        const v = window.__wii.state[0];
        return { kind: v && v.constructor && v.constructor.name, n: v ? v.length : -1 };
      });
      if (st.kind !== 'Float32Array' || st.n !== 10)
        throw new Error(`__wii.state[0] ist ${st.kind}(${st.n}) statt Float32Array(10)`);
      if (rate < 30) throw new Error(`nur ${rate.toFixed(1)} Frames/s (< 30)`);
      const cal = await waitFor(async () => {
        const t = await txt(con, '#slots tbody tr[data-slot="0"] .st');
        return /kalibriert/.test(t) ? t : null;
      }, 5000, 'Slot 0 zeigt "kalibriert"');
      return `${rate.toFixed(1)} fps, state[0] = Float32Array(10), Slot 0 "${cal}"`;
    });

    // __wii.buttons ist die Maske der *gehaltenen* Tasten: ein kompletter Klick setzt und
    // loescht das Bit binnen weniger ms, den Zwischenstand sieht kein Polling. Also halten.
    await step('4 Button A -> __wii.buttons[0] & 1', 15000, async () => {
      await con.evaluate(() => { window.__wii.buttons[0] = 0; });
      await ctrl.page.locator('.k[data-id="0"]').hover();
      await ctrl.page.mouse.down();
      let b;
      try {
        b = await waitFor(async () => {
          const v = await con.evaluate(() => window.__wii.buttons[0] | 0);
          return (v & 1) ? v : null;
        }, 8000, 'buttons[0] Bit 0');
      } finally { await ctrl.page.mouse.up(); }
      await waitFor(async () => !(await con.evaluate(() => window.__wii.buttons[0] & 1)), 4000, 'buttons[0] wieder 0');
      return `buttons[0] = ${b}, nach dem Loslassen 0`;
    });

    // Zeiger: feste hold-Winkel legen ihn genau auf #sample-1 – Umkehrung der Strahl-
    // projektion aus index.html (x = W/2 + D·dx/dy, y = H/2 − D·dz/dy mit D = 0.87·W).
    // Der Controller macht aus hold = −az, el die Richtung d = (sin az·cos el, cos az·cos el,
    // sin el), also x = W/2 + D·tan(az) und y = H/2 − D·tan(el)/cos(az) – das cos(az) muss
    // in die Umkehrung, sonst liegt der Zeiger am Bildrand mehrere Prozent zu weit außen.
    await step('5 Zeiger auf #sample-1: hover + Klick per Taste A', 40000, async () => {
      const aim = await con.evaluate(() => {
        const r = document.getElementById('sample-1').getBoundingClientRect();
        const W = innerWidth, H = innerHeight, D = 0.87 * W, deg = v => v * 180 / Math.PI;
        const x = r.left + r.width / 2, y = r.top + r.height / 2, az = Math.atan((x - W / 2) / D);
        return { a: -deg(az), b: deg(Math.atan((H / 2 - y) * Math.cos(az) / D)), nx: x / W, ny: y / H };
      });
      await ctrl.page.goto(`${BASE}/controller?room=${code}&fake=1&hold=${aim.a.toFixed(3)},${aim.b.toFixed(3)}`,
                           { waitUntil: 'domcontentloaded' });
      await ctrl.page.click('#start');
      await waitFor(async () => /Slot 0/.test(await txt(ctrl.page, '#state')), 15000, 'resume auf Slot 0');
      // Solange nicht kalibriert ist, zeigt die Console das Fadenkreuz statt eines Zeigers.
      await waitFor(() => con.evaluate(() => !document.getElementById('target').hidden),
                    8000, 'Fadenkreuz vor der Kalibrierung sichtbar');
      await calibrate(ctrl.page);
      await waitFlow(con, 0, 15000, 'Frames mit festen Winkeln');
      await waitFor(() => con.evaluate(() => document.getElementById('target').hidden),
                    5000, 'Fadenkreuz nach der Kalibrierung weg');
      await sleep(300);                                     // Glättung (0.5/Frame) einschwingen lassen
      await waitFor(() => con.evaluate(() => document.getElementById('sample-1').classList.contains('wii-hover')),
                    8000, '#sample-1 bekommt wii-hover');
      const pt = await con.evaluate(() => window.__wii.pointer[0]);
      if (!pt || Math.abs(pt[0] - aim.nx) > 0.02 || Math.abs(pt[1] - aim.ny) > 0.02)
        throw new Error(`__wii.pointer[0] = [${pt}] statt ~[${aim.nx.toFixed(3)}, ${aim.ny.toFixed(3)}]`);
      await ctrl.page.click('.k[data-id="0"]');
      const label = await waitFor(async () => {
        const t = await txt(con, '#sample-1');
        return /· 1×$/.test(t) ? t : null;
      }, 8000, 'Zähler auf #sample-1');
      return `"${label}", pointer[0] = [${pt[0].toFixed(3)}, ${pt[1].toFixed(3)}]`;
    });

    await step('6 selectedPath auf der Console', 20000, async () => {
      return await waitFor(async () => {
        const t = await txt(con, '#slots tbody tr[data-slot="0"] .pa');
        return t && t !== '–' && t !== 'none' ? t : null;
      }, 18000, 'selectedPath');
    });

    // R1 (Plan 08) / A8 (Plan 10): Der DataChannel haengt nicht am Signaling. Nach dem
    // Neustart sind die Raeume weg (in-memory) -> resume scheitert mit RESUME_INVALID.
    // Beide Seiten duerfen eine verbundene PeerConnection dabei NICHT schliessen.
    await step('7 R1: signaling neu starten, Partie laeuft weiter', 60000, async () => {
      const before = await seqOf(con, 0);
      execSync(`${COMPOSE} restart signaling`, { cwd: ROOT, stdio: 'pipe' });
      await sleep(3000);
      const h = await waitFor(async () => {
        const t = await txt(con, '#hint');
        return /Spiel läuft weiter/.test(t) ? t : null;
      }, 30000, 'Console-Hinweis nach RESUME_INVALID');
      const banner = await txt(ctrl.page, '#msg');
      if (!/Spiel läuft weiter/.test(banner))
        throw new Error(`Controller zeigt "${banner}" statt des Weiterspiel-Hinweises`);
      // erst nach dem Hinweis messen: beweist, dass die PC den Abbau ueberlebt hat
      const f = await waitFlow(con, 0, 15000, 'Frames nach signaling-Neustart');
      const st = await txt(con, '#slots tbody tr[data-slot="0"] .st');
      if (!/^connected \(ohne Signaling\) · kalibriert$/.test(st))
        throw new Error(`Slot 0 zeigt "${st}" statt "connected (ohne Signaling) · kalibriert"`);
      return `ab seq ${before}: ${f}, Slot 0 "${st}"`;
    });

    // Der alte Raum ist serverseitig weg -> fuer die Reload-Schritte einen frischen anlegen.
    await step('8 Frischer Raum nach dem Neustart', 30000, async () => {
      await ctrl.page.close(); await con.close();
      con = await openConsole('console2');
      ctrl = await joinController('controller2', 'fake=1&hold=0,0');
      if (ctrl.slot !== 0) throw new Error(`Slot ${ctrl.slot} statt 0`);
      await calibrate(ctrl.page);
      await waitFlow(con, 0, 20000, 'Frames im neuen Raum');
      return `room ${code}, ${ctrl.state}`;
    });

    await step('9 R5: Console-Reload -> resume, Frames fliessen', 30000, async () => {
      await con.reload({ waitUntil: 'domcontentloaded' });
      // #code kommt sofort aus sessionStorage, beweist also fuer sich nichts. Beweis ist,
      // dass Frames des unveraenderten Controllers die frische Seite erreichen: das geht
      // nur, wenn der Server auf diesen neuen Socket `peer-joined` geschickt hat.
      const f = await waitFlow(con, 0, 15000, 'Frames nach Console-Reload');
      const again = await txt(con, '#code');
      if (again !== code) throw new Error(`Code ${again} statt ${code} nach Reload`);
      if (!await con.evaluate(() => document.getElementById('pre').hidden))
        throw new Error('Console zeigt wieder "Raum erstellen" – resume abgelehnt (RESUME_INVALID)');
      return `${again}, ${f}`;
    });

    // Nach resume verlangt der Controller erneut eine Kalibrierung (Overlay ist wieder da).
    await step('10 Controller-Reload -> resume, gleicher Slot', 30000, async () => {
      await ctrl.page.reload({ waitUntil: 'domcontentloaded' });
      await ctrl.page.click('#start');
      const st = await waitFor(async () => {
        const t = await txt(ctrl.page, '#state');
        return /Slot 0/.test(t) ? t : null;
      }, 12000, 'resume auf Slot 0');
      await quiet(con, 0, 500, 'nach resume');
      await calibrate(ctrl.page);
      const f = await waitFlow(con, 0, 15000, 'Frames nach Controller-Reload');
      // Ein fehlgeschlagener resume waere ein frischer join in Slot 1 – Slots 1-3 muessen frei bleiben.
      const busy = await con.$$eval('#slots tbody tr', rs =>
        rs.map(r => r.querySelector('.st').textContent.trim()).slice(1).filter(t => t !== 'frei'));
      if (busy.length) throw new Error(`Slots 1-3 nicht frei (${busy}) – resume hat einen neuen Slot belegt`);
      return `${st}, ${f}`;
    });

    // ponytail: die drei Zusatz-Controller werden nicht kalibriert – hier zaehlt nur der
    // Join (ohne fake=1 kaeme headless ohnehin kein einziger Sensor-Frame).
    await step('11 5 Controller -> Slots 1-3 + ROOM_FULL', 45000, async () => {
      const got = [];
      for (let i = 2; i <= 4; i++) got.push((await joinController('ctrl' + i, '')).slot);
      const full = watch(await ctx.newPage(), 'ctrl5');
      await full.setViewportSize(PORTRAIT);
      await full.goto(`${BASE}/controller?room=${code}`, { waitUntil: 'domcontentloaded' });
      await full.click('#start');
      const msg = await waitFor(async () => {
        return (await full.isVisible('#msg')) && (await txt(full, '#msg')) || null;
      }, 12000, 'ROOM_FULL sichtbar');
      if (!/voll/i.test(msg)) throw new Error(`fünfter Controller zeigt "${msg}" statt ROOM_FULL`);
      if (got.slice().sort().join(',') !== '1,2,3') throw new Error(`Slots ${got} statt 1,2,3`);
      return `Slots ${got.join(',')} belegt, 5. Controller: "${msg}"`;
    });

    // Regression: veralteter Raum in sessionStorage (Raum abgelaufen oder signaling neu
    // deployt) -> resume scheitert, der Socket bleibt aber offen. Frueher schickte der
    // Klick dann nichts und "Raum erstellen" war ~10 s tot.
    await step('12 Abgelaufener Raum: "Raum erstellen" wirkt sofort', 20000, async () => {
      const p = watch(await ctx.newPage(), 'console-stale');
      await p.goto(`${BASE}/?debug`, { waitUntil: 'domcontentloaded' });
      await p.evaluate(() => sessionStorage.setItem('wii.host', JSON.stringify({ room: 'ZZZZZ', hostToken: 'abgelaufen' })));
      await p.reload({ waitUntil: 'domcontentloaded' });
      await waitFor(async () => /neu erstellen/.test(await txt(p, '#hint')), 8000, 'RESUME_INVALID');
      const ta = Date.now();
      await p.click('#create');
      const fresh = await waitFor(async () => {
        const t = await txt(p, '#code');
        return CODE_RE.test(t) && t !== 'ZZZZZ' ? t : null;
      }, 8000, 'neuer Raum nach Klick');
      const took = Date.now() - ta;
      if (took > 3000) throw new Error(`neuer Raum erst nach ${took} ms – Klick lief ins Leere`);
      return `neuer Raum ${fresh} nach ${took} ms`;
    });

    // --- Schnittfest (Plan 02, Schritt 5): eigener Raum mit ?rounds=2, damit die
    // Partie kurz ist. Die Schritte 1-12 bleiben davon unberuehrt.
    const GAME = ['13 Schnittfest: Start-Screen per Zeiger',
                  '14 Kachel "Schnittfest" startet das Spiel',
                  '14b Signaling weg und zurueck: kein Neukalibrieren',
                  '15 Treffer per __fakeSwing(target)',
                  '16 Partie zu Ende: Ergebnis, "Menü"'];
    if (!HAS_GAME) GAME.forEach(n => skip(n, 'out/schnittfest.js fehlt (Plan 02, Schritt 1)'));
    else {
      await step(GAME[0], 90000, async () => {
        gcon = await openConsole('console-game', 'rounds=3');   // eine Runde geht in Schritt 14b verloren
        const g = await joinController('controller-game', 'fake=1&hold=0,0');
        gctrl = g.page;
        if (g.slot !== 0) throw new Error(`Slot ${g.slot} statt 0`);
        // Fuer Schritt 14b: jede kuenftige Signaling-Verbindung dieser Seite laeuft ueber
        // eine Route, die der Test kappen kann. Greift ab der naechsten Navigation – die
        // macht aimClick gleich sowieso.
        await gctrl.routeWebSocket(/\/ws$/, ws => { ws.connectToServer(); gws = ws; gwsN++; });
        await calibrate(gctrl);
        await waitFlow(gcon, 0, 20000, 'Frames im Spiel-Raum');
        await aimClick(gcon, gctrl, '#startbtn', 'Start');   // nur Spieler 1 darf starten
        await waitFor(() => shown(gcon, 'menu'), 8000, 'Wii-Menü sichtbar');
        return `room ${code} (?rounds=3)`;
      });

      await step(GAME[1], 90000, async () => {
        const t = await txt(gcon, '#grid .ch[data-game="schnittfest"]');
        if (t !== 'Schnittfest') throw new Error(`Kachel 1 heißt "${t}" statt "Schnittfest"`);
        await aimClick(gcon, gctrl, '#grid .ch[data-game="schnittfest"]', 'Kachel Schnittfest');
        await waitFor(() => shown(gcon, 'game'), 8000, '#game sichtbar');
        await waitFor(() => gctrl.isVisible('#lock'), 8000, 'Motion-Overlay am Controller');
        // Die Schwertspitze zeichnet das Spiel selbst (Plan 02) – die .wii-pointer sind aus,
        // geklickt wird erst wieder auf dem Ergebnis.
        const tip = await waitFor(() => gcon.evaluate(() => window.Schnittfest.debug().tips[0]),
                                  8000, 'Schwertspitze in debug().tips[0]');
        if (await gcon.evaluate(() =>
          Array.prototype.some.call(document.querySelectorAll('.wii-pointer'), p => !p.hidden)))
          throw new Error('.wii-pointer im Spiel sichtbar');
        if (await gcon.evaluate(() => !!document.querySelector('.wii-hover')))
          throw new Error('Hover-Rahmen im Spiel');
        if (!await gcon.evaluate(() => document.getElementById('gresult').hidden))
          throw new Error('Ergebnisbox schon vor dem Spiel sichtbar');
        return `Spiel läuft, Handy gesperrt, Spitze bei [${tip.map(v => v.toFixed(0))}], .wii-pointer aus`;
      });

      // Der iPhone-Fall: mitten im Spiel bricht nur das Signaling weg (WLAN-Wechsel,
      // Proxy-Hiccup), die PeerConnection laeuft weiter. Playwrights WebSocket-Route kappt
      // genau diese eine Verbindung, danach laeuft der resume-Pfad ({t:'resume'} -> `joined`
      // mit resumed:true) ohne Reload durch: kein Neukalibrieren, Overlay bleibt.
      // (?debug fehlt hier, also ist #target im Spiel-View ohnehin aus – die Probe zaehlt
      //  als Gegenprobe fuer den Ergebnis-Screen mit.)
      await step(GAME[2], 60000, async () => {
        if (!gws) throw new Error('Signaling des Controllers laeuft nicht ueber die Route');
        const n = gwsN;
        await gws.close();
        const a = await seqOf(gcon, 0);
        await sleep(250);                                   // Backoff ist 1 s – so lange gibt es nur WebRTC
        const b = await seqOf(gcon, 0);
        const alive = b !== 0 && b !== a;
        await waitFor(() => gwsN > n, 25000, 'neue Signaling-Verbindung');
        // Frames fliessen nur wieder, wenn resume durchkam: ein RESUME_INVALID landete
        // ueber stop() im Beitritts-View, ein fehlendes ref liesse push() schweigen.
        const f = await waitFlow(gcon, 0, 25000, 'Frames nach dem Signaling-Abriss');
        const st = await txt(gctrl, '#state');
        if (!/connected|wieder verbunden/.test(st)) throw new Error(`Controller-Status "${st}"`);
        if (!await gctrl.evaluate(() => document.getElementById('cal').hidden))
          throw new Error('Controller verlangt eine neue Kalibrierung');
        if (!await gctrl.isVisible('#lock')) throw new Error('Motion-Overlay ist weg');
        if (!await gcon.evaluate(() => document.getElementById('target').hidden))
          throw new Error('Console zeigt das Fadenkreuz');
        return `getrennt: nur Signaling (PeerConnection ${alive ? 'lief weiter' : 'stand still'}), ` +
               `"${st}", ${f}, #cal aus, #lock an`;
      });

      // Pro Objekt koennen 3 s Countdown + 0,6 s Einflug + bis 5 s Wartezeit vergehen,
      // bevor der Pfeil steht – deshalb wartet waitCut bis 20 s.
      await step(GAME[3], 45000, async () => {
        const cut = await waitCut(gcon, 20000);
        await gctrl.evaluate(t => window.__fakeSwing(t), cut.target);
        const last = await waitFor(async () => {
          const d = await gcon.evaluate(() => window.Schnittfest.debug());
          return d && d.last && d.last[0] ? d.last[0] : null;
        }, 8000, 'Schwung von Slot 0 in debug().last');
        const diff = Math.abs((((last.angle - cut.target) % 360) + 540) % 360 - 180);
        if (diff > 10) throw new Error(`Schwung ${last.angle}° statt ${cut.target}° (${diff.toFixed(1)}° daneben)`);
        await waitFor(async () => (await gcon.evaluate(() => window.Schnittfest.debug().phase)) !== 'cut',
                      4000, 'Objekt gelöst');
        // scores stehen nicht zwingend in debug() – dann zählt die Rangliste in Schritt 16.
        const sc = await gcon.evaluate(() => {
          const d = window.Schnittfest.debug();
          return d && d.scores ? (d.scores[0] | 0) : null;
        });
        if (sc !== null && sc !== 1) throw new Error(`scores[0] = ${sc} statt 1`);
        return `Ziel ${cut.target}°, Schwung ${Number(last.angle).toFixed(1)}°` +
               (sc === null ? ', scores nicht in debug()' : `, scores[0] = ${sc}`);
      });

      await step(GAME[4], 75000, async () => {
        const end = Date.now() + 35000;   // eine Runde dauert bis 8,3 s
        let armed = false;                                  // je Objekt nur ein Schwung
        while (Date.now() < end && await gcon.evaluate(() => document.getElementById('gresult').hidden)) {
          const d = await gcon.evaluate(() => window.Schnittfest.debug());
          if (!d || d.phase !== 'cut') armed = true;
          else if (armed) { await gctrl.evaluate(t => window.__fakeSwing(t), d.target); armed = false; }
          await sleep(60);
        }
        await waitFor(() => shown(gcon, 'gresult'), 10000, 'Ergebnisbox sichtbar');
        await waitFor(async () => !(await gctrl.isVisible('#lock')), 8000, 'Motion-Overlay weg');
        await waitFor(() => gcon.evaluate(() =>
          Array.prototype.some.call(document.querySelectorAll('.wii-pointer'), p => !p.hidden)),
          5000, 'Zeiger auf dem Ergebnis wieder da');
        const rank = await gcon.$$eval('#grank li', ls => ls.map(l => `${l.dataset.slot}:${l.dataset.score}`));
        if (!rank.length) throw new Error('Rangliste leer');
        const top = rank[0].split(':');
        if (top[0] !== '0' || Number(top[1]) < 1) throw new Error(`Rangliste [${rank}] – Slot 0 ohne Punkt`);
        await gcon.click('#gmenu');
        await waitFor(async () => (await shown(gcon, 'menu')) && !(await shown(gcon, 'game')),
                      5000, 'zurück im Wii-Menü');
        return `Rangliste [${rank}], Menü zurück im Grid`;
      });
    }

    // --- Fruit Ninja (Plan 03, Schritt 5): eigener Raum mit ?lives=1, damit die erste
    // verpasste Frucht die Partie beendet. Kein Hieb noetig, kein __fakeSwing.
    const FN = ['18 Fruit Ninja: Kachel startet das Spiel',
                '19 Objekte erscheinen, verpasste Frucht beendet (?lives=1)',
                '20 "Nochmal" und "Menü" zurueck ins Grid',
                '20b Wii-Knopf mitten im Spiel'];
    if (!HAS_FN) FN.forEach(n => skip(n, 'out/fruitninja.js fehlt (Plan 03, Schritt 2)'));
    else {
      const fdbg = () => fcon.evaluate(() => window.FruitNinja.debug() || {});

      await step(FN[0], 120000, async () => {
        if (gctrl) await gctrl.close();                      // der Schnittfest-Raum wird nicht mehr gebraucht
        if (gcon) await gcon.close();
        fcon = await openConsole('console-fn', 'lives=1');
        const f = await joinController('controller-fn', 'fake=1&hold=0,0');
        fctrl = f.page;
        if (f.slot !== 0) throw new Error(`Slot ${f.slot} statt 0`);
        await calibrate(fctrl);
        await waitFlow(fcon, 0, 20000, 'Frames im Fruit-Ninja-Raum');
        await aimClick(fcon, fctrl, '#startbtn', 'Start');    // nur Spieler 1 darf starten
        await waitFor(() => shown(fcon, 'menu'), 8000, 'Wii-Menü sichtbar');
        const t = await txt(fcon, '#grid .ch[data-game="fruitninja"]');
        if (t !== 'Fruit Ninja') throw new Error(`Kachel 2 heißt "${t}" statt "Fruit Ninja"`);
        await aimClick(fcon, fctrl, '#grid .ch[data-game="fruitninja"]', 'Kachel Fruit Ninja');
        await waitFor(() => shown(fcon, 'game'), 8000, '#game sichtbar');
        if (!await fcon.isVisible('#g3d')) throw new Error('#g3d ist nicht sichtbar');
        await waitFor(() => fctrl.isVisible('#lock'), 8000, 'Motion-Overlay am Controller');
        // Ohne WebGL-Kontext (fehlendes SwiftShader-Flag) käme three.js gar nicht erst hoch.
        await waitFor(async () => (await fdbg()).renderer === 'webgl', 15000, 'WebGL-Renderer');
        // Die Klinge sitzt am Zeiger – bei hold=0,0 ungefaehr in der Bildmitte.
        const tip = await waitFor(async () => (await fdbg()).tip, 8000, 'Klinge in debug().tip');
        if (await fcon.evaluate(() =>
          Array.prototype.some.call(document.querySelectorAll('.wii-pointer'), p => !p.hidden)))
          throw new Error('.wii-pointer im Spiel sichtbar');
        if (!await fcon.evaluate(() => document.getElementById('gresult').hidden))
          throw new Error('Ergebnisbox schon vor dem Spiel sichtbar');
        return `room ${code} (?lives=1), Klinge bei ${JSON.stringify(tip)}`;
      });

      await step(FN[1], 75000, async () => {
        const sp = await waitFor(async () => {
          const d = await fdbg();
          return d.spawned >= 1 ? d.spawned : null;
        }, 15000, 'erstes Objekt geworfen');                 // 3 s Countdown liegen davor
        // Die erste Frucht steigt bis 75-95 % und faellt ungeschnitten zurueck (~3 s);
        // bei ?lives=1 ist die Partie damit vorbei.
        await waitFor(async () => (await fdbg()).phase === 'over', 20000, 'verpasste Frucht beendet die Partie');
        await waitFor(() => shown(fcon, 'gresult'), 10000, 'Ergebnisbox sichtbar');
        const rank = await fcon.$$eval('#grank li', ls => ls.map(l => `${l.dataset.slot}:${l.dataset.score}`));
        if (rank.length !== 1) throw new Error(`Rangliste [${rank}] – genau ein Eintrag erwartet (Single-Player)`);
        if (rank[0].split(':')[0] !== '0') throw new Error(`Rangliste [${rank}] – Slot 0 erwartet`);
        await waitFor(async () => !(await fctrl.isVisible('#lock')), 8000, 'Motion-Overlay weg');
        await waitFor(() => fcon.evaluate(() =>
          Array.prototype.some.call(document.querySelectorAll('.wii-pointer'), p => !p.hidden)),
          5000, 'Zeiger auf dem Ergebnis wieder da');
        return `spawned ${sp}, Rangliste [${rank}], Handy entsperrt`;
      });

      // „Nochmal“ hat kein data-game und muss das zuletzt gespielte Spiel starten (index.html:
      // lastGame). Der zweite Start beweist nebenbei, dass stop()/start() denselben
      // WebGL-Kontext weiterbenutzen. Danach zurueck ins Grid – erst dort ist #again wieder weg.
      await step(FN[2], 60000, async () => {
        await fcon.click('#again');
        await waitFor(async () => {
          const ph = (await fdbg()).phase;
          return ph === 'countdown' || ph === 'play';
        }, 10000, 'zweite Partie laeuft');
        if (!await fcon.evaluate(() => document.getElementById('gresult').hidden))
          throw new Error('Ergebnisbox bleibt in der zweiten Partie stehen');
        await waitFor(async () => (await fdbg()).phase === 'over', 25000, 'zweite Partie zu Ende');
        await waitFor(() => shown(fcon, 'gresult'), 10000, 'Ergebnisbox der zweiten Partie');
        await fcon.click('#gmenu');
        await waitFor(async () => (await shown(fcon, 'menu')) && !(await shown(fcon, 'game')),
                      5000, 'zurück im Wii-Menü');
        return '„Nochmal“ startete Fruit Ninja erneut, „Menü“ zurück im Grid';
      });

      await step(FN[3], 60000, async () => {
        await fcon.click('#grid .ch[data-game="fruitninja"]');   // Maus reicht: nur „Start“ prueft den Klicker
        await waitFor(async () => (await fdbg()).phase === 'play', 20000, 'Countdown vorbei');
        // Der Wii-Knopf sitzt in der Menue-Leiste und ist im Spiel verdeckt – also im
        // Dokument ausloesen statt mit der Maus.
        await fcon.evaluate(() => document.getElementById('wiibtn').click());
        await waitFor(async () => (await shown(fcon, 'start')) && !(await shown(fcon, 'game')),
                      5000, 'zurück auf dem Start-Screen');
        await waitFor(async () => !(await fctrl.isVisible('#lock')), 8000, 'Motion-Overlay weg');
        const ph = (await fdbg()).phase;
        if (ph !== 'off') throw new Error(`FruitNinja.debug().phase = "${ph}" statt "off"`);
        return 'Spiel gestoppt, Handy entsperrt, Start-Screen';
      });
    }

    // ponytail: Wake Lock braucht ein echtes, sichtbares Fenster – headless
    // lehnt navigator.wakeLock.request('screen') immer ab. Der Client faengt den
    // Fehler ab (keepAwake ist best effort), pruefbar ist das hier nicht.
    skip('17 Wake Lock', 'headless Chromium: kein screen wake lock');
  } catch (e) {
    ok = false;
    if (!e.reported) console.log('Fehler ausserhalb eines Schritts:', e.stack || e.message);
  } finally {
    await browser.close().catch(() => {});
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n--- Zusammenfassung ---');
  for (const [s, n, m, note] of results) console.log(`${s.padEnd(5)} ${pad(n)} ${ms_(m)}  ${note}`);
  console.log(`Laufzeit ${dur} s`);

  if (!ok) {
    console.log('\n--- Browser-Console (beide Seiten) ---');
    console.log(logs.length ? logs.join('\n') : '(leer)');
  }
  process.exit(ok ? 0 : 1);
})();
