// Procedural, audio-reactive background.
//
// Everything here is driven by real analysis data from the live store:
//   onset           → an expanding ring (repeated plucks give rhythmic rings)
//   note start      → hue from the note's pitch class; melodic direction
//                     sends a burst of particles up or down
//   sustained note  → particles flow outward at a rate set by the level
//   tuning accuracy → gold when in tune, teal otherwise
//   level           → central glow
//   confidence      → particle opacity
// No pre-rendered or looping animation is used.

import { direction, levelIntensity, pitchHue, tuningZone } from "@naghma/ui";
import type { WatarStore } from "../../lib/live";
import type { VisualQuality } from "../../lib/types";

interface Ring {
  r: number;
  alpha: number;
  hue: number;
  width: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
  size: number;
}

const LIMITS: Record<Exclude<VisualQuality, "off">, { particles: number; rings: number; glow: boolean }> = {
  full: { particles: 420, rings: 10, glow: true },
  reduced: { particles: 90, rings: 5, glow: false },
};

const GOLD_HUE = 42;
const TEAL_HUE = 174;

export class VisualEngine {
  private ctx: CanvasRenderingContext2D;
  private rings: Ring[] = [];
  private particles: Particle[] = [];
  private glow = 0;
  private hue = TEAL_HUE;
  private noteHue = TEAL_HUE;
  private lastPitch: number | null = null;
  private emitCarry = 0;
  private w = 0;
  private h = 0;
  private time = 0;
  /** Hue and glow of the last full redraw; null = the canvas must be redrawn. */
  private drawn: { hue: number; glow: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private store: WatarStore,
    private quality: VisualQuality,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.resize();
  }

  setQuality(q: VisualQuality): void {
    this.quality = q;
    if (q === "off") {
      this.particles = [];
      this.rings = [];
    }
    this.drawn = null;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawn = null; // Resizing clears the canvas.
  }

  /** Advance by `dt` seconds and draw. */
  step(dt: number): void {
    this.time += dt;
    const { ctx, w, h } = this;
    const cx = w / 2;
    const cy = h * 0.36;
    const frame = this.store.frame;
    const note = frame?.state === "note" ? frame.note : null;
    const intensity = frame ? levelIntensity(frame.levelDb) : 0;
    const confidence = frame?.confidence ?? 0;

    // Consume discrete events.
    const onsets = this.store.pendingOnsets;
    this.store.pendingOnsets = 0;
    const starts = this.store.pendingStarts.splice(0);

    for (const s of starts) {
      this.noteHue = pitchHue(s.pitch);
      const dir = direction(this.lastPitch, s.pitch);
      this.lastPitch = s.pitch;
      if (this.quality !== "off" && dir !== 0) this.burst(cx, cy, dir, this.noteHue);
    }

    // Colour: pitch hue blended toward gold (in tune) or teal.
    const accuracyHue = note && tuningZone(note.cents) === "inTune" ? GOLD_HUE : TEAL_HUE;
    const targetHue = note ? mixHue(this.noteHue, accuracyHue, 0.55) : TEAL_HUE;
    this.hue = mixHue(this.hue, targetHue, Math.min(1, dt * 4));
    this.glow += (intensity * (note ? 1 : 0.35) - this.glow) * Math.min(1, dt * 6);

    // Idle (nothing moving, colour and glow settled): the canvas already
    // shows this frame, so skip the full-screen repaint.
    const drawn = this.drawn;
    if (
      drawn &&
      onsets === 0 &&
      starts.length === 0 &&
      this.particles.length === 0 &&
      this.rings.length === 0 &&
      !(note && this.quality !== "off") &&
      Math.abs(((this.hue - drawn.hue + 540) % 360) - 180) < 0.05 &&
      Math.abs(drawn.glow - this.glow) < 1e-3
    )
      return;
    this.drawn = { hue: this.hue, glow: this.glow };

    // Background.
    ctx.globalCompositeOperation = "source-over";
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.8);
    bg.addColorStop(0, `hsl(${this.hue} 45% ${7 + this.glow * 9}%)`);
    bg.addColorStop(0.55, "hsl(225 30% 6%)");
    bg.addColorStop(1, "hsl(228 35% 3%)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (this.quality === "off") return;
    const limits = LIMITS[this.quality];

    // Onset rings.
    for (let i = 0; i < Math.min(onsets, 2); i++) {
      this.rings.push({ r: 40, alpha: 0.55 + 0.4 * intensity, hue: this.hue, width: 2 + 4 * intensity });
    }
    if (this.rings.length > limits.rings) this.rings.splice(0, this.rings.length - limits.rings);

    // Sustained-note particles.
    if (note) {
      this.emitCarry += dt * (20 + 160 * intensity) * (this.quality === "full" ? 1 : 0.3);
      while (this.emitCarry >= 1 && this.particles.length < limits.particles) {
        this.emitCarry -= 1;
        const a = Math.random() * Math.PI * 2;
        const speed = 30 + 90 * intensity;
        const r0 = 70 + Math.random() * 30;
        this.particles.push({
          x: cx + Math.cos(a) * r0,
          y: cy + Math.sin(a) * r0,
          vx: Math.cos(a) * speed + Math.cos(a + Math.PI / 2) * 25,
          vy: Math.sin(a) * speed + Math.sin(a + Math.PI / 2) * 25,
          life: 0,
          maxLife: 1.2 + Math.random() * 1.6,
          hue: this.hue + (Math.random() - 0.5) * 20,
          size: 1 + Math.random() * 2.2,
        });
      }
    } else {
      this.emitCarry = 0;
    }

    ctx.globalCompositeOperation = "lighter";

    // Central glow.
    if (limits.glow && this.glow > 0.01) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 220 + 160 * this.glow);
      g.addColorStop(0, `hsla(${this.hue} 80% 60% / ${0.22 * this.glow})`);
      g.addColorStop(1, "hsla(0 0% 0% / 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Rings.
    for (const ring of this.rings) {
      ring.r += dt * (260 + ring.width * 30);
      ring.alpha -= dt * 0.7;
      if (ring.alpha <= 0) continue;
      ctx.strokeStyle = `hsla(${ring.hue} 75% 65% / ${ring.alpha})`;
      ctx.lineWidth = ring.width;
      ctx.beginPath();
      ctx.arc(cx, cy, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.rings = this.rings.filter((r) => r.alpha > 0);

    // Particles: gentle swirl + drag.
    const swirl = Math.sin(this.time * 0.7) * 0.4;
    const opacity = 0.35 + 0.65 * Math.min(1, confidence);
    for (const p of this.particles) {
      p.life += dt;
      const dx = p.x - cx;
      const dy = p.y - cy;
      p.vx += -dy * swirl * dt * 0.6;
      p.vy += dx * swirl * dt * 0.6;
      p.vx *= 1 - dt * 0.6;
      p.vy *= 1 - dt * 0.6;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.life / p.maxLife;
      if (k <= 0) continue;
      ctx.fillStyle = `hsla(${p.hue} 85% 68% / ${k * opacity})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + k), 0, Math.PI * 2);
      ctx.fill();
    }
    this.particles = this.particles.filter((p) => p.life < p.maxLife);
    ctx.globalCompositeOperation = "source-over";
  }

  private burst(cx: number, cy: number, dir: 1 | -1, hue: number): void {
    const limits = LIMITS[this.quality as "full" | "reduced"];
    const n = this.quality === "full" ? 36 : 10;
    for (let i = 0; i < n && this.particles.length < limits.particles; i++) {
      const spread = (Math.random() - 0.5) * 1.4;
      const speed = 120 + Math.random() * 160;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 120,
        y: cy,
        vx: Math.sin(spread) * speed * 0.6,
        vy: -dir * Math.cos(spread) * speed,
        life: 0,
        maxLife: 0.9 + Math.random() * 0.8,
        hue: hue + (Math.random() - 0.5) * 30,
        size: 1.2 + Math.random() * 2,
      });
    }
  }
}

function mixHue(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
