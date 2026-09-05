using System.Runtime.InteropServices;
using UnityEngine;

// Brücke zum JS-Client (Plan 05, Schritt 7). Das GameObject muss "WiiInput" heißen,
// sonst findet unityInstance.SendMessage('WiiInput', …) es nicht.
// buf-Layout je Slot: [t, ax, ay, az, rx, ry, rz, dx, dy, dz] (Float32, m/s², °/s,
// Einheitsvektor der Handy-Längsachse in der Kalibrier-Basis).
public class WiiInput : MonoBehaviour
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern int WiiReadState(int slot, float[] outBuf);
    [DllImport("__Internal")] static extern int WiiPollButtons(int slot);
    [DllImport("__Internal")] static extern void WiiMotionMode(int on);
#else
    // Im Editor gibt es kein jslib – Stubs, damit die Szene startet.
    static int WiiReadState(int slot, float[] outBuf) { return 0; }
    static int WiiPollButtons(int slot) { return 0; }
    static void WiiMotionMode(int on) { }
#endif

    readonly float[] buf = new float[10];
    readonly int[] lastSeq = new int[4];
    readonly int[] held = new int[4];

    void Update()
    {
        for (int s = 0; s < 4; s++)
        {
            int seq = WiiReadState(s, buf);
            if (seq != 0 && seq != lastSeq[s]) { lastSeq[s] = seq; Apply(s, buf); }
            int b = WiiPollButtons(s);
            int pressed = b & ~held[s], released = held[s] & ~b;
            held[s] = b;
            if (pressed != 0) OnPressed(s, pressed);
            if (released != 0) OnReleased(s, released);
        }
    }

    // Hier das Spiel anbinden: Neigung, Beschleunigung, Drehrate je Slot.
    void Apply(int slot, float[] b) { }

    // Tasten: Bit 0 = A, 1 = B, 2 = 1, 3 = 2. Flanken kommen einmal pro Druck bzw. Loslassen,
    // IsHeld liefert den aktuellen Zustand für „gedrückt halten“ (z. B. Gas geben, Zielen).
    void OnPressed(int slot, int bits) { }
    void OnReleased(int slot, int bits) { }
    public bool IsHeld(int slot, int button) { return (held[slot] & (1 << button)) != 0; }

    // Motion-only-Spiel: alle Controller sperren Touch (schwarzes Overlay, 2 s halten entsperrt).
    public void SetMotionMode(bool on) { WiiMotionMode(on ? 1 : 0); }

    // Seltene Ereignisse kommen per SendMessage. Der WebGL-Loader reicht JS-Zahlen
    // als float durch, deshalb float statt int.
    public void OnPlayerJoined(float slot)
    {
        int s = (int)slot;
        lastSeq[s] = 0;
        Debug.Log("WiiInput: Spieler " + s + " verbunden");
    }

    public void OnPlayerLeft(float slot)
    {
        int s = (int)slot;
        lastSeq[s] = 0; held[s] = 0;
        Debug.Log("WiiInput: Spieler " + s + " getrennt");
    }
}
