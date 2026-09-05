// Nach Assets/Plugins/WebGL/Wii.jslib kopieren (Plan 05, Schritt 7).
// Kein SendMessage pro Frame: JS hält den letzten Frame je Slot in window.__wii,
// Unity pollt ihn in Update() – allokationsfrei.
mergeInto(LibraryManager.library, {
  WiiReadState: function (slot, outPtr) { var w = window.__wii; if (!w || !w.state[slot]) return 0; HEAPF32.set(w.state[slot], outPtr >> 2); return w.seq[slot]; },
  WiiPollButtons: function (slot) { var w = window.__wii; return w ? w.buttons[slot] : 0; },   // gehaltene Tasten, wird nicht gelöscht
  WiiMotionMode: function (on) { var w = window.__wii; if (w && w.motion) w.motion(!!on); }   // Controller: Touch sperren (Motion-only-Spiele)
});
