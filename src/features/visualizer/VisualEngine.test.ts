import { describe, expect, it } from "vitest";
import { WatarStore } from "../../lib/live";
import { VisualEngine } from "./VisualEngine";

/** A canvas whose 2D context only counts full-screen fills. */
function fakeCanvas() {
  let fills = 0;
  const gradient = { addColorStop() {} };
  const ctx = {
    setTransform() {},
    createRadialGradient: () => gradient,
    fillRect: () => fills++,
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    clientWidth: 400,
    clientHeight: 300,
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, fills: () => fills };
}

(globalThis as { window?: unknown }).window ??= { devicePixelRatio: 1 };

describe("VisualEngine", () => {
  it("stops repainting once idle and repaints after a resize or an onset", () => {
    const { canvas, fills } = fakeCanvas();
    const store = new WatarStore();
    const engine = new VisualEngine(canvas, store, "full");
    for (let i = 0; i < 120; i++) engine.step(1 / 60);
    const settled = fills();
    for (let i = 0; i < 60; i++) engine.step(1 / 60);
    expect(fills()).toBe(settled);

    engine.resize();
    engine.step(1 / 60);
    expect(fills()).toBeGreaterThan(settled);

    const before = fills();
    store.pendingOnsets = 1;
    engine.step(1 / 60);
    expect(fills()).toBeGreaterThan(before);
  });
});
