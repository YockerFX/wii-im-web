'use strict';
// Schnittfest – erstes Motion-Spiel (Plan game-creation/02).
// Klassisches Script wie wii.js (CSP: script-src 'self' 'unsafe-inline', kein Modul,
// kein CDN). detector() und match() sind reine Funktionen ohne DOM – sie laufen
// unter `node --test` und wandern später 1:1 nach C#, wenn Unity kommt.
var Schnittfest = (function () {

  // --- Konstanten (Plan „Schnitt-Erkennung“ und „Regeln“) -------------------
  var SWING_SPEED = 2;           // Schwelle in Bildschirmhöhen pro Sekunde (H/s)
  var CUT_R = 0.7;               // erlaubter Abstand der Schnittlinie zur Objektmitte, in Objektradien
  var ARM_MS = 150;              // so lange bleibt die Spitze nach dem Eintritt von außen „scharf“
  var SWING_COOLDOWN_MS = 300;   // Ruhe nach einem erkannten Schnitt
  var TOL_DEG = 45;              // erlaubte Abweichung vom Zielwinkel (Richtungen liegen 45° auseinander, ±45°: die nächstgelegene Richtung zählt)
  var DIRECTIONS = [0, 45, 90, 135, 180, 225, 270, 315];  // gerichtet: 0 = nach rechts, 90 = nach oben, 270 = nach unten
  var ROUNDS = 10;               // Objekte je Partie
  var OBJ_R = 0.12;              // Objektradius in Bildschirmhöhen – Zeichnen und Erkennung nutzen denselben Kreis
  // wait ist zufällig 1000–5000 ms, damit kein Rhythmus entsteht und niemand blind schwingen kann.
  var FLYIN_MS = 600, WAIT_MIN_MS = 1000, WAIT_SPAN_MS = 4000, CUT_MS = 2000, RESOLVED_MS = 700;
  var COUNT_MS = 3000;           // Countdown 3-2-1 vor dem ersten Objekt
  var SWING_SHOW_MS = 900;       // so lange steht der erkannte Schwung als Pfeil im Bild
  var SWORD_G = 1.2;             // Auslenkung der Spitze in Bildschirmhöhen je Einheit von d
  var REST_MS = 300;             // Zeitkonstante, mit der die Ruhelage der Richtung nachläuft
  var REST_RATE = 60;            // ab dieser Winkelgeschwindigkeit (°/s) friert die Ruhelage ein
  var TIP_R = 0.25;              // Radius der gezeichneten Schwertspitze in Objektradien
  var FROM = ['links', 'rechts', 'oben'];
  var RAD = Math.PI / 180;

  // Am echten Handy nachziehen: /?swing=3 (Schwelle in H/s).
  // In Node gibt es kein location – dann bleiben es 2 H/s.
  if (typeof location === 'object' && location.search) {
    var qs = parseFloat(new URLSearchParams(location.search).get('swing'));
    if (qs > 0) SWING_SPEED = qs;
  }

  // --- Schnitt-Erkennung ----------------------------------------------------
  // Abstand des Punktes C zur Strecke P0P1 – zur Strecke, nicht zur Geraden: ein Hieb,
  // der vor dem Objekt endet, schneidet nichts.
  function segDist(cx, cy, x0, y0, x1, y1) {
    var dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? ((cx - x0) * dx + (cy - y0) * dy) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var ex = x0 + t * dx - cx, ey = y0 + t * dy - cy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Ein Schnitt ist, wenn die Schwertspitze (sword() weiter unten) schnell von außen durch
  // das Objekt fährt. Ausholen beginnt auf dem Objekt und führt von ihm weg – das zählt
  // nicht, erst der Rückweg. Gyroskop und Beschleunigung sind bewusst raus: beide konnten
  // Ausholen und Schlag nicht unterscheiden (echtes iPhone, 2026-09-03).
  // detector(H) bekommt die Bildschirmhöhe in Pixeln; das Feld `H` darf beim Fenster-Resize
  // nachgezogen werden – die Console tut das je Frame in poll().
  function detector(H) {
    var px = 0, py = 0, pt = 0, has = false, wasIn = false, armed = 0, cool = 0;
    var d = {
      H: H || 1,
      // Spitze (x, y), Console-Zeit, Objektmitte (cx, cy) und Objektradius r – alles in Pixeln.
      feed: function (x, y, nowMs, cx, cy, r) {
        var ex = x - cx, ey = y - cy;
        var inside = ex * ex + ey * ey <= r * r;
        var x0 = px, y0 = py, t0 = pt, had = has, out0 = !wasIn;
        px = x; py = y; pt = nowMs; has = true;
        if (had && out0 && inside) armed = nowMs + ARM_MS;        // Eintritt von außen: 150 ms scharf
        wasIn = inside;
        if (!had || nowMs <= t0) return null;                     // erster Frame bzw. Zeit steht
        var speed = Math.sqrt((x - x0) * (x - x0) + (y - y0) * (y - y0)) / (nowMs - t0) * 1000 / d.H;
        if (speed < SWING_SPEED || nowMs < cool) return null;
        if (!out0 && nowMs >= armed) return null;                 // Ausholen aus der Ruhe auf dem Objekt
        if (segDist(cx, cy, x0, y0, x, y) > CUT_R * r) return null;
        cool = nowMs + SWING_COOLDOWN_MS; armed = 0;
        // Bildschirm-y zeigt nach unten, daher das Minus: 0 = nach rechts, 90 = nach oben.
        var angle = Math.atan2(-(y - y0), x - x0) / RAD;
        return { angle: ((angle % 360) + 360) % 360, mag: speed };
      }
    };
    return d;
  }

  // --- Schwertspitze relativ zur Ruhelage -----------------------------------
  // d = Richtung der Handy-Längsachse in der Kalibrier-Basis (x rechts, y zur Bildschirm-
  // mitte, z oben), Einheitsvektor – kein Gier/Nick-Modell, also auch keine Singularität,
  // wenn das Handy wie ein Schwert aufrecht steht. Die Ruhelage r läuft d nach, solange
  // sich d langsam bewegt, und friert beim Schwung ein: ruhige Hand = Spitze auf dem
  // Objekt, in jeder Haltung, und der Schwung ist die Abweichung davon.
  // sword(G) liefert Pixel um 0; G darf wie detector.H beim Resize nachgezogen werden.
  function sword(G) {
    var rx = 0, ry = 0, rz = 0, px = 0, py = 0, pz = 0, pt = 0, has = false;
    var s = {
      G: G || 1,
      feed: function (dx, dy, dz, nowMs) {
        var dt = nowMs - pt;
        if (!has) { has = true; rx = dx; ry = dy; rz = dz; }
        else if (dt > 0) {
          // Winkel zwischen zwei aufeinanderfolgenden Richtungen (beide Einheitsvektoren).
          var c = px * dx + py * dy + pz * dz;
          var rate = Math.acos(c < -1 ? -1 : (c > 1 ? 1 : c)) / RAD / (dt / 1000);
          if (rate < REST_RATE) {
            var k = 1 - Math.exp(-dt / REST_MS);
            rx += (dx - rx) * k; ry += (dy - ry) * k; rz += (dz - rz) * k;
            var n = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;   // nachgeführt heißt auch: wieder normieren
            rx /= n; ry /= n; rz /= n;
          }
        }
        px = dx; py = dy; pz = dz; pt = nowMs;
        return { x: s.G * (dx - rx), y: -s.G * (dz - rz) };        // Bildschirm-y zeigt nach unten
      }
    };
    return s;
  }

  // Winkelvergleich gerichtet, modulo 360 – nach unten trifft „von oben nach unten“
  // und failt „von unten nach oben“.
  function diff(a, b) { return Math.abs((((a - b + 180) % 360) + 360) % 360 - 180); }

  // --- Spielregeln ----------------------------------------------------------
  // slots: [0, 2] – opts: { rounds, rnd }. rnd macht die Tests deterministisch.
  function match(slots, opts) {
    opts = opts || {};
    var rounds = opts.rounds || ROUNDS, rnd = opts.rnd || Math.random;
    var scores = {}, locked = [], fails = {}, pending = [];
    var phase = 'flyin', round = 1, target = 0, winner = null, from = FROM[0];
    var started = false, until = 0;
    for (var i = 0; i < slots.length; i++) scores[slots[i]] = 0;

    function pick(a) { return a[Math.min(a.length - 1, Math.floor(rnd() * a.length))]; }
    function ranking() {
      var out = slots.map(function (s) { return { slot: s, score: scores[s] }; });
      out.sort(function (a, b) { return b.score - a.score || a.slot - b.slot; });
      return out;
    }
    function next(ev) {                                           // nächstes Objekt oder Schluss
      round++;
      if (round > rounds) { phase = 'over'; ev.push({ t: 'over', ranking: ranking() }); return; }
      phase = 'flyin'; locked = []; fails = {}; winner = null; target = 0;
      from = pick(FROM); until += FLYIN_MS;
    }

    return {
      tick: function (nowMs) {
        var ev = pending; pending = [];
        if (phase === 'over') return ev;
        if (!started) { started = true; from = pick(FROM); until = nowMs + FLYIN_MS; }
        while (nowMs >= until && phase !== 'over') {
          if (phase === 'flyin') { phase = 'wait'; until += WAIT_MIN_MS + rnd() * WAIT_SPAN_MS; }
          else if (phase === 'wait') { phase = 'cut'; target = pick(DIRECTIONS); until += CUT_MS; ev.push({ t: 'cut', target: target }); }
          else if (phase === 'cut') { phase = 'resolved'; winner = null; until += RESOLVED_MS; ev.push({ t: 'nobody' }); }
          else next(ev);                                          // resolved → nächste Runde
        }
        return ev;
      },
      swing: function (slot, angle, nowMs) {
        if (scores[slot] === undefined || !started) return 'ignored';   // kein Mitspieler / noch kein Objekt
        if (phase === 'flyin' || phase === 'resolved' || phase === 'over') return 'ignored';
        if (locked.indexOf(slot) >= 0) return 'locked';
        if (phase === 'wait' || diff(angle, target) > TOL_DEG) {
          var why = phase === 'wait' ? 'early' : 'wrong';
          locked.push(slot); fails[slot] = why;
          if (locked.length >= slots.length) {                    // niemand mehr im Rennen
            phase = 'resolved'; winner = null; until = nowMs + RESOLVED_MS;
            pending.push({ t: 'nobody' });                        // bei early fällt das Objekt vor dem Pfeil
          }
          return why;
        }
        winner = slot; scores[slot]++; phase = 'resolved'; until = nowMs + RESOLVED_MS;
        pending.push({ t: 'hit', slot: slot });
        return 'hit';
      },
      // ponytail: gibt die lebenden Objekte zurück – Aufrufer lesen nur, das spart Kopien je Frame.
      state: function () {
        return { phase: phase, round: round, target: target, scores: scores,
                 lockedSlots: locked, fails: fails, winner: winner, objectFrom: from };
      }
    };
  }

  // --- Partie in der Console: pollen, rechnen, zeichnen ----------------------
  var run = null;

  function start(o) {
    stop();
    var cvs = o.canvas, ctx = cvs.getContext('2d'), ps = o.players || [];
    var slots = [], det = {}, sw = {}, seen = {}, last = {}, tip = {}, prev = {}, fc = {}, fps = {}, i, sl;
    for (i = 0; i < ps.length; i++) {
      sl = ps[i].slot; slots.push(sl);
      det[sl] = detector(innerHeight); sw[sl] = sword(innerHeight * SWORD_G);
      seen[sl] = -1; last[sl] = null; tip[sl] = null; prev[sl] = null; fc[sl] = 0; fps[sl] = 0;
    }
    var now = performance.now();
    var r = {
      m: match(slots, { rounds: o.rounds }), ps: ps, rounds: o.rounds || ROUNDS,
      cvs: cvs, ctx: ctx, det: det, sw: sw, seen: seen, last: last, onEnd: o.onEnd,
      tip: tip, prev: prev, fc: fc, fps: fps, fpsAt: now,
      ready: now + COUNT_MS, phase: 'flyin', phaseAt: now, raf: 0, fit: null
    };
    r.fit = function () {
      var d = window.devicePixelRatio || 1;
      cvs.width = Math.round(innerWidth * d); cvs.height = Math.round(innerHeight * d);
      cvs.style.width = innerWidth + 'px'; cvs.style.height = innerHeight + 'px';
      ctx.setTransform(d, 0, 0, d, 0, 0);                        // gezeichnet wird in CSS-Pixeln
    };
    r.fit();
    addEventListener('resize', r.fit);
    run = r;
    frame();
  }

  function stop() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    removeEventListener('resize', run.fit);
    run.ctx.setTransform(1, 0, 0, 1, 0, 0);
    run.ctx.clearRect(0, 0, run.cvs.width, run.cvs.height);
    run = null;
  }

  // Zusätzlich zum Plan stehen scores/round drin – E2E und Tuning lesen sie mit.
  function debug() {
    if (!run) return { phase: 'off', target: 0, last: {}, tips: {} };
    var st = run.m.state();
    return { phase: performance.now() < run.ready ? 'countdown' : st.phase, target: st.target,
             last: run.last, tips: run.tip, scores: st.scores, round: st.round };
  }

  function frame() {
    var r = run; if (!r) return;
    var now = performance.now(), i, sl;
    poll(r, now);
    if (now - r.fpsAt >= 1000) {                                  // fps je Spieler aus den seq-Wechseln
      for (i = 0; i < r.ps.length; i++) {
        sl = r.ps[i].slot;
        r.fps[sl] = Math.round(r.fc[sl] * 1000 / (now - r.fpsAt)); r.fc[sl] = 0;
      }
      r.fpsAt = now;
    }
    if (now >= r.ready) {
      var ev = r.m.tick(now), st = r.m.state();
      if (st.phase !== r.phase) { r.phase = st.phase; r.phaseAt = now; }
      for (i = 0; i < ev.length; i++) {
        if (ev[i].t !== 'over') continue;
        draw(r, now); r.raf = 0;                                  // Schleife aus, Bild bleibt stehen
        if (r.onEnd) r.onEnd(ev[i].ranking);
        return;
      }
    }
    draw(r, now);
    r.raf = requestAnimationFrame(frame);
  }

  // __wii.state[slot] wird je Frame ersetzt, deshalb nicht cachen, sondern über seq prüfen:
  // Frame-Layout [t, ax, ay, az, rx, ry, rz, dx, dy, dz]. Gefüttert wird auch im flyin –
  // gewertet wird erst in match.swing.
  function poll(r, now) {
    var w = window.__wii; if (!w || !w.state) return;
    var W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2, R = H * OBJ_R;
    for (var i = 0; i < r.ps.length; i++) {
      var slot = r.ps[i].slot, v = w.state[slot];
      if (!v || w.seq[slot] === r.seen[slot]) continue;           // kein Handy / kein neuer Frame
      r.seen[slot] = w.seq[slot]; r.fc[slot]++;
      r.sw[slot].G = H * SWORD_G; r.det[slot].H = H;              // Fenster kann sich zwischendurch ändern
      var p = r.sw[slot].feed(v[7], v[8], v[9], now);
      r.prev[slot] = r.tip[slot];
      r.tip[slot] = [cx + p.x, cy + p.y];
      var s = r.det[slot].feed(cx + p.x, cy + p.y, now, cx, cy, R);
      if (!s) continue;
      r.last[slot] = { angle: s.angle, mag: s.mag, at: now };
      r.m.swing(slot, s.angle, now);
    }
  }

  // --- Zeichnen -------------------------------------------------------------
  function ball(ctx, x, y, R) {
    ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI);
    ctx.fillStyle = '#e8dfc8'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
  }
  // Dicker Pfeil durch das Objekt, Spitze in Zielrichtung. 0° = rechts, 90° = oben –
  // Canvas-y zeigt nach unten, also den Winkel spiegeln (-deg).
  function arrow(ctx, x, y, deg, R) {
    var len = R * 1.9, head = R * 0.75;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(-deg * RAD);
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff';
    ctx.lineWidth = Math.max(6, R * 0.17); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len - head, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(len, 0);
    ctx.lineTo(len - head, head * 0.62); ctx.lineTo(len - head, -head * 0.62);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // Erkannter Schnitt: dünnerer Pfeil (halbe Dicke) vom Objektmittelpunkt nach außen in
  // Spielerfarbe, dazu die Gradzahl am Ende. Damit sieht man am Handy sofort, welchen
  // Winkel der Detektor aus dem Hieb gemacht hat („nach unten gehauen → 270° erkannt“).
  function swingArrow(ctx, x, y, deg, R, color) {
    var len = R * 1.4, head = R * 0.3, a = -deg * RAD;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a);
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = Math.max(3, R * 0.085); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len - head, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(len, 0);
    ctx.lineTo(len - head, head * 0.62); ctx.lineTo(len - head, -head * 0.62);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText(Math.round(deg) + '°', x + Math.cos(a) * (len + R * 0.22), y + Math.sin(a) * (len + R * 0.22));
  }

  // Schwertspitze: kleiner Kreis in Spielerfarbe mit kurzem Schweif zur vorigen Position.
  // Die .wii-pointer sind im Spiel aus – das Spiel zeichnet die Spitzen selbst.
  function tipMark(ctx, p, q, R, color) {
    ctx.fillStyle = ctx.strokeStyle = color; ctx.lineCap = 'round';
    if (q) {
      ctx.lineWidth = R * TIP_R; ctx.globalAlpha = 0.4;
      ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.arc(p[0], p[1], R * TIP_R, 0, 2 * Math.PI); ctx.fill();
  }

  // Versionsstempel für den Handy-Test: welcher Stand läuft mit welchen Parametern.
  // document.lastModified ist ein String wie „09/03/2026 17:33:32“, die Uhrzeit reicht;
  // unter node --test gibt es kein document, dann steht dort „?“.
  function stamp() {
    var d = typeof document === 'object' && document.lastModified
      ? String(document.lastModified).slice(11, 16) : '?';
    return 'Stand ' + d + ' · swing ' + SWING_SPEED + ' · tol ' + TOL_DEG;
  }

  function colorOf(r, slot) {
    for (var i = 0; i < r.ps.length; i++) if (r.ps[i].slot === slot) return r.ps[i].color || '#fff';
    return '#fff';
  }

  function draw(r, now) {
    var ctx = r.ctx, W = innerWidth, H = innerHeight, st = r.m.state(), i;
    var R = H * OBJ_R, cx = W / 2, cy = H / 2, age = now - r.phaseAt, p, x = cx, y = cy;
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';

    if (now < r.ready) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold ' + Math.round(H * 0.3) + 'px system-ui, sans-serif';
      ctx.fillText(String(Math.ceil((r.ready - now) / 1000)), cx, cy);
    } else if (st.phase === 'resolved') {
      p = Math.min(1, age / RESOLVED_MS);
      ctx.globalAlpha = 1 - p * 0.6;
      if (st.winner === null) {
        ball(ctx, cx, cy + p * p * H * 0.7, R);                   // niemand: Objekt fällt
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#8b949e';
        ctx.font = 'bold ' + Math.round(H * 0.05) + 'px system-ui, sans-serif';
        ctx.fillText('Niemand', cx, cy + R + H * 0.09);
      } else {
        // Zwei Hälften: an der Schnittlinie geclippt, senkrecht dazu auseinander und nach unten.
        var a = -st.target * RAD, nx = -Math.sin(a), ny = Math.cos(a);
        var off = p * R * 1.2, fall = p * p * H * 0.35;
        for (var k = -1; k <= 1; k += 2) {
          ctx.save();
          ctx.translate(cx + nx * off * k, cy + ny * off * k + fall);
          ctx.rotate(a);                                          // Schnittlinie liegt auf der x-Achse
          ctx.beginPath(); ctx.rect(-2 * R, k > 0 ? 0 : -2 * R, 4 * R, 2 * R); ctx.clip();
          ball(ctx, 0, 0, R);                                     // Kreis ist rund, Drehung egal
          ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = colorOf(r, st.winner);
        ctx.font = 'bold ' + Math.round(H * 0.05) + 'px system-ui, sans-serif';
        ctx.fillText('Spieler ' + (st.winner + 1) + '!', cx, cy + R + H * 0.09);
      }
      ctx.globalAlpha = 1;
    } else if (st.phase !== 'over') {
      if (st.phase === 'flyin') {
        p = Math.min(1, age / FLYIN_MS);
        var e = 1 - (1 - p) * (1 - p);
        if (st.objectFrom === 'links') x = -R + (cx + R) * e;
        else if (st.objectFrom === 'rechts') x = W + R - (W + R - cx) * e;
        else y = -R + (cy + R) * e;
      }
      ball(ctx, x, y, R);
      if (st.phase === 'cut') arrow(ctx, x, y, st.target, R);
    }

    // Jeder Schwung (hit, wrong, early, auch ignored/locked) bleibt 900 ms als Pfeil in
    // Spielerfarbe stehen – oder bis derselbe Spieler wieder schwingt (r.last wird ersetzt).
    if (now >= r.ready && st.phase !== 'over') {
      for (i = 0; i < r.ps.length; i++) {
        var S = r.last[r.ps[i].slot];
        if (S && now - S.at < SWING_SHOW_MS) swingArrow(ctx, x, y, S.angle, R, r.ps[i].color || '#fff');
      }
    }

    for (i = 0; i < r.ps.length; i++) {
      var T = r.tip[r.ps[i].slot];
      if (T) tipMark(ctx, T, r.prev[r.ps[i].slot], R, r.ps[i].color || '#fff');
    }

    // Fails stehen bis zum Ende von resolved: „Daneben!“ / „Zu früh!“ unter dem Objekt.
    if (now >= r.ready && st.phase !== 'over') {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold ' + Math.round(H * 0.045) + 'px system-ui, sans-serif';
      var fy = cy + R + H * 0.16;
      for (i = 0; i < r.ps.length; i++) {
        var fl = st.fails[r.ps[i].slot]; if (!fl) continue;
        ctx.fillStyle = r.ps[i].color || '#fff';
        ctx.fillText(fl === 'early' ? 'Zu früh!' : 'Daneben!', cx, fy);
        fy += H * 0.055;
      }
    }

    // HUD: Punkte je Spieler in Spielerfarbe, rotes ✕ bei einem Fail, Runde rechts.
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = 'bold 20px system-ui, sans-serif';
    var hx = 24;
    for (i = 0; i < r.ps.length; i++) {
      var t = 'Spieler ' + (r.ps[i].slot + 1) + '  ' + (st.scores[r.ps[i].slot] || 0) + '  ';
      ctx.fillStyle = r.ps[i].color || '#fff';
      ctx.fillText(t, hx, 20);
      hx += ctx.measureText(t).width;
      if (st.fails[r.ps[i].slot]) {
        ctx.fillStyle = '#f85149'; ctx.fillText('✕', hx, 20);
        hx += ctx.measureText('✕').width;
      }
      hx += 28;
    }
    ctx.fillStyle = '#8b949e'; ctx.textAlign = 'right';
    ctx.fillText(Math.min(st.round, r.rounds) + ' / ' + r.rounds, W - 24, 20);

    // Debug-Zeile zum Nachziehen von SWING_SPEED; der Winkel ist gerichtet (0–360°).
    // Ganz oben der Versionsstempel, damit am Handy klar ist, welcher Stand gerade läuft.
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(stamp(), 16, H - 16 - r.ps.length * 16);
    for (i = 0; i < r.ps.length; i++) {
      var L = r.last[r.ps[i].slot];
      ctx.fillStyle = r.ps[i].color || '#8b949e';
      ctx.fillText('Spieler ' + (r.ps[i].slot + 1) + ': ' + r.fps[r.ps[i].slot] + ' fps · letzter Schnitt: ' +
        (L ? L.mag.toFixed(1).replace('.', ',') + ' H/s @ ' + Math.round(L.angle) + '°' : '–'),
        16, H - 16 - (r.ps.length - 1 - i) * 16);
    }
  }

  return { detector: detector, sword: sword, match: match, start: start, stop: stop, debug: debug };
})();
if (typeof module === 'object' && module.exports) module.exports = Schnittfest;
