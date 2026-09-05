'use strict';
// Gemeinsamer Client-Code für Console (index.html) und Controller (controller.html).
// Klassisches Script, kein Modul – die CSP aus files/caddy/site.caddy erlaubt nur
// script-src 'self' 'unsafe-inline': keine CDNs, kein eval, kein Build-Schritt.
var Wii = (function () {

  var Q = new URLSearchParams(location.search);
  var forceRelay = Q.get('forceRelay') === '1';
  var FRAME_BYTES = 44;                       // u16 seq | u16 flags | 10 × f32

  // --- Sensor-Frame (Plan 05, Schritt 3) ------------------------------------
  // vals[0..9] = t, ax, ay, az, rx, ry, rz, dx, dy, dz – alles Little-Endian. d ist die
  // Richtung der Handy-Laengsachse in der Kalibrier-Basis (x rechts, y zur Bildschirmmitte,
  // z oben), Einheitsvektor (Plan game-creation/02).
  // Die 10 Floats liegen ab Byte 4 am Stück, damit die Unity-Brücke sie als
  // Float32Array(data, 4, 10) ohne Kopie an HEAPF32 weiterreichen kann.
  function writeFrame(dv, seq, flags, vals) {
    dv.setUint16(0, seq & 0xffff, true);
    dv.setUint16(2, flags & 0xffff, true);
    for (var i = 0; i < 10; i++) dv.setFloat32(4 + 4 * i, vals[i] || 0, true);
  }
  function readFrame(buf) {
    var dv = new DataView(buf);
    return { seq: dv.getUint16(0, true), flags: dv.getUint16(2, true), vals: new Float32Array(buf, 4, 10) };
  }
  // Verspätete Frames verwerfen; die Sequenz läuft in 16 Bit um.
  function isStale(seq, last) { return ((seq - last) & 0xffff) >= 0x8000; }

  // --- Raum-Code (Spiegel von normalizeCode aus Plan 03, Schritt 6) ----------
  function normalizeCode(s) {
    var c = String(s == null ? '' : s).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{5}$/.test(c) ? c : null;
  }

  // --- PeerConnection + die beiden DataChannels (Plan 05, Schritt 2/3) ------
  // negotiated:true mit festen IDs – beide Seiten bauen exakt dasselbe, kein
  // ondatachannel-Roundtrip. iceServers kommen immer frisch aus der Server-Nachricht.
  function peer(iceServers) {
    var pc = new RTCPeerConnection({
      iceServers: iceServers || [],
      iceTransportPolicy: forceRelay ? 'relay' : 'all'
    });
    var sensors = pc.createDataChannel('sensors', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    var events = pc.createDataChannel('events', { negotiated: true, id: 1 });   // Default: ordered + reliable
    sensors.binaryType = events.binaryType = 'arraybuffer';
    return { pc: pc, sensors: sensors, events: events };
  }

  // ICE-Kandidaten, die vor setRemoteDescription eintreffen, puffern.
  function iceQueue() {
    var pending = [];
    return {
      add: function (pc, cand) {
        if (pc && pc.remoteDescription) pc.addIceCandidate(cand).catch(function () {});
        else pending.push(cand);
      },
      flush: function (pc) {
        var p = pending; pending = [];
        p.forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); });
      }
    };
  }

  // --- Signaling-WebSocket mit Reconnect (Plan 05, Schritt 5) ---------------
  // h = { onOpen, onMessage, onClose? }. App-Ping alle 25 s, kein pong binnen 10 s
  // → close() → Backoff 1/2/4/8 s. Der Server pingt zusätzlich auf ws-Ebene.
  function signal(h) {
    var url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws';
    var ws = null, tries = 0, pingT = null, pongT = null, retryT = null, dead = false;

    function send(m) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    }
    function stopTimers() { clearInterval(pingT); clearTimeout(pongT); pingT = pongT = null; }
    function heartbeat() {
      stopTimers();
      pingT = setInterval(function () {
        if (!send({ t: 'ping' }) || pongT) return;
        pongT = setTimeout(function () { pongT = null; if (ws) ws.close(); }, 10000);
      }, 25000);
    }
    function open() {
      if (dead) return;
      clearTimeout(retryT); retryT = null;
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () { tries = 0; heartbeat(); if (h.onOpen) h.onOpen(); };
      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') return h.onBinary && h.onBinary(ev.data);   // Relay-Frame
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'pong') { clearTimeout(pongT); pongT = null; return; }
        h.onMessage(m);
      };
      ws.onclose = function (ev) { stopTimers(); if (h.onClose) h.onClose(ev); retry(); };
      ws.onerror = function () {};                       // auf error folgt immer close
    }
    function retry() {
      if (dead || retryT) return;
      var wait = [1000, 2000, 4000, 8000][Math.min(tries, 3)];
      tries++;
      retryT = setTimeout(function () { retryT = null; open(); }, wait);
    }
    // visibilitychange / pageshow / online: Hintergrund-Tabs schließen WebSockets
    // ohne verlässliches close-Event, deshalb aktiv nachsehen.
    function ensure() {
      if (dead) return;
      if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) { tries = 0; open(); }
    }
    function close() {
      dead = true; stopTimers(); clearTimeout(retryT); retryT = null;
      if (ws) { send({ t: 'leave' }); ws.close(); }
    }
    function sendBin(buf) {                              // Relay-Datenweg, siehe server.js
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(buf);
      return true;
    }
    return { open: open, send: send, sendBin: sendBin, ensure: ensure, close: close,
             isOpen: function () { return !!ws && ws.readyState === WebSocket.OPEN; } };
  }

  // --- Wake Lock (Plan 05, Schritt 4) --------------------------------------
  var lock = null;
  function keepAwake() {
    if (!navigator.wakeLock) return Promise.resolve(null);
    if (lock && !lock.released) return Promise.resolve(lock);
    return navigator.wakeLock.request('screen').then(function (l) {
      lock = l;
      if (l.addEventListener) l.addEventListener('release', function () { lock = null; });
      return l;
    }, function () { return null; });                    // Fehler bewusst ignorieren
  }

  // --- Telemetrie (Plan 05, Schritt 8) -------------------------------------
  function selectedPath(pc) {
    if (!pc) return Promise.resolve('none');
    return pc.getStats().then(function (st) {
      var pair = null, any = null;
      st.forEach(function (s) {
        if (s.type !== 'candidate-pair' || s.state !== 'succeeded') return;
        if (s.nominated) pair = s; else if (!any) any = s;
      });
      pair = pair || any;                                // Firefox setzt nominated nicht immer
      if (!pair) return 'none';
      var l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId);
      if (!l || !r) return 'none';
      return l.candidateType + '/' + l.protocol + '->' + r.candidateType;
    }, function () { return 'none'; });
  }

  return {
    FRAME_BYTES: FRAME_BYTES, query: Q, forceRelay: forceRelay,
    writeFrame: writeFrame, readFrame: readFrame, isStale: isStale,
    normalizeCode: normalizeCode, peer: peer, iceQueue: iceQueue,
    signal: signal, keepAwake: keepAwake, selectedPath: selectedPath
  };
})();
