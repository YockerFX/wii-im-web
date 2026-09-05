'use strict';
// Tests zu out/schnittfest.js (Plan game-creation/02, Schritt 2).
// Aus dem Projekt-Wurzelverzeichnis: node --test out/schnittfest.test.cjs
// (Node 24 nimmt kein Verzeichnis mehr: `node --test out/` scheitert, `node --test "out/**/*.test.cjs"` geht.)
var test = require('node:test');
var assert = require('node:assert');
var Schnittfest = require('./schnittfest.js');

// Zeiten aus dem Plan, gespiegelt: flyin 600, wait 1000 + rnd·4000, cut 2000, resolved 700.
// Mit rnd = 0 also: flyin bis 600, wait bis 1600, cut bis 3600, resolved bis 4300.
function spiel() { return Schnittfest.match([0, 1], { rounds: 2, rnd: function () { return 0; } }); }

// Bis zum Pfeil durchticken; t0 = Beginn dieses Objekts (nur gültig für rnd = 0).
function bisCut(m, t0) { m.tick(t0); m.tick(t0 + 600); return m.tick(t0 + 1600); }

// --- Schnitt-Erkennung: Geometrie wie im Spiel -------------------------------
// Objekt in der Bildmitte, Radius 12 % der Bildschirmhöhe; die Spitze ist der Zeiger.
var H = 800, W = 1200, CX = W / 2, CY = H / 2, R = H * 0.12;
var DT = 16.7;                                   // 60 Hz

// Punkt auf der Geraden durch die Objektmitte: u Pixel in Richtung deg, o Pixel seitlich
// daneben. Bildschirm-y zeigt nach unten, daher das Minus bei u.
function pt(deg, u, o) {
  var a = deg * Math.PI / 180;
  return [CX + u * Math.cos(a) + o * Math.sin(a), CY - u * Math.sin(a) + o * Math.cos(a)];
}
// Fährt die Spitze in n Frames im Abstand dt von u0 nach u1 entlang deg, seitlich um o
// versetzt; liefert den zuletzt erkannten Schnitt.
function fahre(det, deg, u0, u1, n, t0, dt, o) {
  var out = null;
  for (var i = 0; i < n; i++) {
    var p = pt(deg, u0 + (u1 - u0) * i / (n - 1), o || 0);
    var s = det.feed(p[0], p[1], t0 + i * dt, CX, CY, R);
    if (s) out = s;
  }
  return out;
}
// Schnitt-Salve wie __fakeSwing: 8 Frames à 16,7 ms von 3r außerhalb durch die Mitte bis
// 3r außerhalb – 6,2 H/s, klar über der Schwelle von 2 H/s.
function salve(det, deg, t0) { return fahre(det, deg, -3 * R, 3 * R, 8, t0, DT, 0); }
// Frameabstand, bei dem eine Fahrt von u0 nach u1 in n Frames hs Bildschirmhöhen je Sekunde schnell ist.
function dtFor(u0, u1, n, hs) { return Math.abs(u1 - u0) / (n - 1) / (hs * H) * 1000; }
// gerichtet, modulo 360 – wie in schnittfest.js
function diff(a, b) { return Math.abs((((a - b + 180) % 360) + 360) % 360 - 180); }

// --- Schwertspitze: Richtungsvektor statt Zeiger-Winkel ----------------------
var RAD = Math.PI / 180;
var SG = H * 1.2;                                // G aus SWORD_G = 1,2 Bildschirmhöhen
// Handy-Richtung aus Azimut/Elevation in Grad, genau wie sie der Fake-Controller schickt:
// x rechts, y zur Bildschirmmitte, z oben.
function dir(az, el) {
  var a = az * RAD, e = el * RAD;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

test('sword: ruhige Hand – die Spitze liegt auf der Ruhelage', function () {
  var sw = Schnittfest.sword(SG), p = null;
  for (var i = 0; i < 60; i++) p = sw.feed(0, 1, 0, 1000 + i * DT);   // erster Frame setzt r = d
  assert.ok(Math.hypot(p.x, p.y) < 1e-6, 'Spitze bei ' + p.x + '/' + p.y);
});

test('sword: langsames Wegdriften zieht die Ruhelage mit', function () {
  var sw = Schnittfest.sword(SG), p = null;
  for (var i = 0; i <= 120; i++) {                                   // 2 s Gierdrift mit 1 °/s
    var d = dir(i * DT / 1000, 0);
    p = sw.feed(d[0], d[1], d[2], 1000 + i * DT);
  }
  // Nachlauf ist rund Drift × REST_MS = 0,3° – ein Bruchteil des Objektradius (96 px).
  assert.ok(Math.hypot(p.x, p.y) < 0.1 * R, 'nach 2 s Drift: ' + p.x.toFixed(1) + ' px');
});

test('sword: schneller Schwenk – Ruhelage friert ein, der Rückweg trifft wieder 0', function () {
  var sw = Schnittfest.sword(SG), p = null, t = 1000, i, d;
  sw.feed(0, 1, 0, t);                                               // Ruhelage sitzt
  for (i = 1; i <= 6; i++) { d = dir(30 * i / 6, 0); p = sw.feed(d[0], d[1], d[2], t + i * DT); }
  assert.ok(p.x > 0.4 * SG, '30° in 100 ms → nur ' + p.x.toFixed(0) + ' px');
  for (i = 5; i >= 0; i--) { d = dir(30 * i / 6, 0); p = sw.feed(d[0], d[1], d[2], t + (12 - i) * DT); }
  assert.ok(Math.hypot(p.x, p.y) < 1e-6, 'Rückweg endet bei ' + p.x.toFixed(1) + ' px');
});

test('sword + detector: Ausholen liefert nichts, der Rückweg die Richtung', function () {
  [0, 90, 180, 270].forEach(function (deg) {
    var sw = Schnittfest.sword(SG), det = Schnittfest.detector(H);
    var ux = Math.cos(deg * RAD), uy = Math.sin(deg * RAD), t = 1000, hit = null, i, s;
    function feed(az, el) {
      var d = dir(az, el), p = sw.feed(d[0], d[1], d[2], t);
      var out = det.feed(CX + p.x, CY + p.y, t, CX, CY, R);
      t += DT;
      return out;
    }
    for (i = 0; i < 18; i++) assert.equal(feed(0, 0), null, deg + '°: Ruhe ist kein Schnitt');
    // Ausholen: 30° in 100 ms von der Ruhelage weg – beginnt auf dem Objekt, zählt nicht.
    for (i = 1; i <= 6; i++)
      assert.equal(feed(-30 * ux * i / 6, -30 * uy * i / 6), null, deg + '°: Ausholen zählt nicht');
    for (i = 0; i < 8; i++) {                                        // Rückweg wie __fakeSwing
      s = -1 + 2 * i / 7;
      var out = feed(30 * ux * s, 30 * uy * s);
      if (out) hit = out;
    }
    assert.ok(hit, deg + '°: Rückweg nicht erkannt');
    assert.ok(diff(hit.angle, deg) <= 5, deg + '° → ' + hit.angle + '°');
  });
});

test('detector: eine Fahrt durch das Objekt liefert die gerichtete Schnittrichtung', function () {
  [0, 45, 90, 135, 180, 225, 270, 315].forEach(function (deg) {
    var s = salve(Schnittfest.detector(H), deg, 1000);
    assert.ok(s, 'Salve bei ' + deg + '° nicht erkannt');
    assert.ok(diff(s.angle, deg) <= 5, deg + '° → ' + s.angle + '°');
    assert.ok(s.mag > 6 && s.mag < 6.4, 'mag ' + s.mag + ' H/s');
  });
});

test('detector: ein Hieb nach unten ist nicht einer nach oben', function () {
  var s = salve(Schnittfest.detector(H), 270, 1000);     // Bildschirm-y zeigt nach unten
  assert.ok(diff(s.angle, 270) <= 5, '270° → ' + s.angle + '°');
  assert.ok(diff(s.angle, 90) > 175, '270° darf nicht als 90° durchgehen: ' + s.angle + '°');
});

test('detector: langsam durch die Mitte ist kein Schnitt', function () {
  var det = Schnittfest.detector(H);
  assert.equal(fahre(det, 0, -3 * R, 3 * R, 8, 1000, dtFor(-3 * R, 3 * R, 8, 0.5)), null);
});

test('detector: Ausholen zählt nicht, der Rückweg schon', function () {
  var det = Schnittfest.detector(H);
  det.feed(CX, CY, 1000, CX, CY, R);                    // Spitze ruht auf dem Objekt
  // Ausholen: aus der Ruhe schnell nach oben aus dem Objekt heraus – nie scharf.
  assert.equal(fahre(det, 90, 0, 3 * R, 5, 1000 + DT, DT), null);
  var s = fahre(det, 270, -3 * R, 3 * R, 8, 1400, DT);  // Rückweg: von oben durch die Mitte nach unten
  assert.ok(s, 'Rückweg nicht erkannt');
  assert.ok(diff(s.angle, 270) <= 5, 'Rückweg → ' + s.angle + '°');
});

test('detector: nach langsamem Zurücklegen verfällt die Schärfung', function () {
  var det = Schnittfest.detector(H);
  var dt = dtFor(-3 * R, 0, 8, 0.5);                    // langsam von oben auf das Objekt
  assert.equal(fahre(det, 270, -3 * R, 0, 8, 1000, dt), null);
  var t = 1000 + 7 * dt;
  det.feed(CX, CY, t + 300, CX, CY, R);                 // 300 ms Ruhe: die 150 ms sind längst um
  assert.equal(fahre(det, 90, 0, 3 * R, 5, t + 300 + DT, DT), null);
});

test('detector: schneller Vorbeiflug knapp neben der Mitte zählt nicht', function () {
  var det = Schnittfest.detector(H);                    // 0,9·r Abstand, erlaubt sind 0,7·r
  assert.equal(fahre(det, 0, -3 * R, 3 * R, 8, 1000, DT, 0.9 * R), null);
});

test('detector: kein zweiter Schnitt im Cooldown', function () {
  var det = Schnittfest.detector(H);
  assert.ok(salve(det, 0, 1000));                                     // Schnitt bei 1067
  // Rückweg auf derselben Geraden, ohne Sprung: liegt komplett im Cooldown (300 ms).
  assert.equal(fahre(det, 180, -3 * R, 3 * R, 8, 1150, DT), null);
  var s = salve(det, 0, 2000);                                        // danach wieder scharf
  assert.ok(s && diff(s.angle, 0) <= 5, 'nach dem Cooldown: ' + (s && s.angle));
});

test('match: Schwung vor dem Pfeil sperrt für dieses Objekt', function () {
  var m = spiel();
  m.tick(0); m.tick(600);
  assert.equal(m.state().phase, 'wait');
  assert.equal(m.swing(0, 0, 700), 'early');
  assert.deepEqual(m.state().lockedSlots, [0]);
  assert.equal(m.state().fails[0], 'early');
  assert.equal(m.state().phase, 'wait');         // Spieler 2 ist noch im Rennen
  m.tick(1600);
  assert.equal(m.state().phase, 'cut');
  assert.equal(m.swing(0, 0, 1700), 'locked');   // gesperrt bleibt gesperrt
  assert.equal(m.state().scores[0], 0);
});

test('match: falscher Winkel sperrt, richtiger gibt den Punkt', function () {
  var m = spiel();
  var ev = bisCut(m, 0);
  assert.deepEqual(ev, [{ t: 'cut', target: 0 }]);
  assert.equal(m.swing(0, 90, 1700), 'wrong');   // Ziel 0°, Toleranz ±45°
  assert.equal(m.state().fails[0], 'wrong');
  assert.equal(m.swing(0, 0, 1710), 'locked');
  assert.equal(m.swing(1, 30, 1720), 'hit');     // noch innerhalb der Toleranz
  var st = m.state();
  assert.equal(st.phase, 'resolved');
  assert.equal(st.winner, 1);
  assert.equal(st.scores[1], 1);
  assert.deepEqual(m.tick(1730), [{ t: 'hit', slot: 1 }]);
});

test('match: Richtung zählt – 180° gegenüber ist falsch', function () {
  var m = Schnittfest.match([0, 1], { rounds: 1, rnd: function () { return 0.8; } });
  m.tick(0); m.tick(600);                             // wait = 1000 + 0.8·4000 = 4200 ms
  assert.deepEqual(m.tick(4800), [{ t: 'cut', target: 270 }]);   // Pfeil nach unten
  assert.equal(m.swing(0, 90, 4810), 'wrong');        // nach oben: 180° daneben
  assert.equal(m.swing(1, 265, 4820), 'hit');         // nach unten: 5° daneben

  var m2 = Schnittfest.match([0, 1], { rounds: 1, rnd: function () { return 0.2; } });
  m2.tick(0); m2.tick(600);                           // wait = 1000 + 0.2·4000 = 1800 ms
  assert.deepEqual(m2.tick(2400), [{ t: 'cut', target: 45 }]);
  assert.equal(m2.swing(0, 225, 2410), 'wrong');      // Gegen-Diagonale
  assert.equal(m2.swing(1, 10, 2420), 'hit');         // 35° daneben, innerhalb der Toleranz
});

test('match: Toleranz ±45° – 40° daneben trifft, 50° daneben nicht', function () {
  var m = spiel();
  bisCut(m, 0);                                  // Ziel 0°
  assert.equal(m.swing(0, 50, 1700), 'wrong');   // 50° daneben, 45° liegt näher
  assert.equal(m.swing(1, 40, 1710), 'hit');     // 40° daneben, 0° ist die nächste Richtung
  assert.equal(m.state().scores[1], 1);
});

test('match: zweiter richtiger Schwung ist ignored', function () {
  var m = spiel();
  bisCut(m, 0);
  assert.equal(m.swing(1, 0, 1700), 'hit');
  assert.equal(m.swing(0, 0, 1701), 'ignored');  // Objekt ist gelöst
  assert.equal(m.state().scores[0], 0);
});

test('match: sind nach einem wrong alle gesperrt, fällt das Objekt sofort', function () {
  var m = spiel();
  bisCut(m, 0);                                  // Ziel 0°, cut liefe bis 3600
  assert.equal(m.swing(0, 180, 1700), 'wrong');
  assert.equal(m.state().phase, 'cut');          // Spieler 2 darf noch
  assert.equal(m.swing(1, 180, 1710), 'wrong');
  assert.equal(m.state().phase, 'resolved');     // ohne die 2 s abzuwarten
  assert.equal(m.state().winner, null);
  assert.deepEqual(m.tick(1720), [{ t: 'nobody' }]);
  m.tick(2500);                                  // resolved (bis 2410) vorbei → Objekt 2
  assert.equal(m.state().round, 2);
  assert.deepEqual(m.state().lockedSlots, []);
  assert.deepEqual(m.state().fails, {});
});

test('match: early beim einzigen Spieler lässt das Objekt sofort fallen', function () {
  var m = Schnittfest.match([0], { rounds: 2, rnd: function () { return 0; } });
  m.tick(0); m.tick(600);
  assert.equal(m.state().phase, 'wait');
  assert.equal(m.swing(0, 0, 700), 'early');
  assert.equal(m.state().phase, 'resolved');     // Objekt fällt, bevor der Pfeil je erschien
  assert.deepEqual(m.tick(710), [{ t: 'nobody' }]);
  assert.equal(m.state().target, 0);
  assert.equal(m.state().scores[0], 0);
});

test('match: ohne Schwung fällt das Objekt', function () {
  var m = spiel();
  bisCut(m, 0);
  assert.deepEqual(m.tick(3600), [{ t: 'nobody' }]);
  assert.equal(m.state().winner, null);
});

test('match: nach rounds kommt over mit sortiertem Ranking', function () {
  var m = spiel();
  bisCut(m, 0);
  assert.equal(m.swing(1, 0, 1700), 'hit');      // Objekt 1 → Slot 1, resolved bis 2400
  assert.deepEqual(m.tick(2400), [{ t: 'hit', slot: 1 }]);   // resolved vorbei → Objekt 2
  assert.equal(m.state().round, 2);
  m.tick(3000);                                  // flyin (bis 3000) → wait
  assert.deepEqual(m.tick(4000), [{ t: 'cut', target: 0 }]); // wait (bis 4000) → cut
  assert.equal(m.swing(0, 90, 4100), 'wrong');   // Ziel ist wieder 0°
  assert.equal(m.swing(1, 0, 4110), 'hit');      // resolved bis 4810
  var ev = m.tick(4810);                         // resolved vorbei → keine Runde mehr
  assert.deepEqual(ev, [{ t: 'hit', slot: 1 },
                        { t: 'over', ranking: [{ slot: 1, score: 2 }, { slot: 0, score: 0 }] }]);
  assert.equal(m.state().phase, 'over');
  assert.equal(m.swing(0, 0, 5000), 'ignored');
  assert.deepEqual(m.tick(9000), []);            // nach over passiert nichts mehr
});

test('debug ohne laufende Partie', function () {
  assert.equal(Schnittfest.debug().phase, 'off');
  assert.deepEqual(Schnittfest.debug().tips, {});
});
