// pnpm screenshots — regenerate the README images from demo mode (?demo), so no real session
// data ever lands in the repo. Starts its own Vite server and drives the installed Google Chrome;
// the backend and its database are never touched.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import gifenc from "gifenc";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const { GIFEncoder, quantize, applyPalette } = gifenc;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const PORT = 5191;
const BASE = `http://localhost:${PORT}/`;
const VIEWPORT = { width: 1440, height: 900 };
const TOUR_MS = 6 * 3500; // one full ?demo=tour loop (see createDemo in web/src/demo.ts)
const GIF_WIDTH = 960;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  const proc = spawn("pnpm", ["--dir", "web", "exec", "vite", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return proc;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  proc.kill();
  throw new Error(`Vite didn't start on :${PORT}`);
}

async function load(page, query) {
  await page.goto(BASE + query);
  await page.waitForSelector(".lane-scroll .slot");
  await page.evaluate(() => document.fonts.ready);
  await sleep(1800); // flip counters + strip fade-ins settle
}

async function stills(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: "dark", locale: "en-US" });
  const page = await ctx.newPage();
  const shot = (name) => page.screenshot({ path: OUT + name });

  await load(page, "?demo");
  await shot("board.png");

  await load(page, "?demo");
  // click the strip body (the title itself jumps to the session's window)
  await page.locator(".lane-scroll .strip", { hasText: "Generate invoice PDFs" }).evaluate((el) => el.click());
  await sleep(1200);
  await shot("detail.png");

  await load(page, "?demo");
  await page.locator(".lane-label", { hasText: "In-flight" }).click();
  await sleep(600);
  await shot("grid.png");
  await ctx.close();
}

// area-average downscale of an RGBA buffer
function downscale(src, w, h, dw) {
  const dh = Math.round((h * dw) / w);
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = w / dw;
  const sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

// share of pixels that differ noticeably — used to fold near-identical frames into one
function changed(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 16) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  return n / (a.length / 16);
}

// every 4th pixel of every frame, so one shared palette covers the moving tokens too
function paletteSample(frames) {
  const out = new Uint8ClampedArray(frames.reduce((n, f) => n + f.data.length / 4, 0) + 4);
  let o = 0;
  for (const f of frames) {
    for (let i = 0; i < f.data.length; i += 16) {
      out[o++] = f.data[i]; out[o++] = f.data[i + 1]; out[o++] = f.data[i + 2]; out[o++] = 255;
    }
  }
  return out.subarray(0, o);
}

async function tourGif(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark", locale: "en-US" });
  const page = await ctx.newPage();
  await load(page, "?demo=tour");
  // Freeze looping CSS animations (activity spinners, the "needs you" flash) so static stretches
  // collapse into single frames. The taxi runs on the Web Animations API and is unaffected.
  await page.addStyleTag({ content: "*, *::before, *::after { animation-play-state: paused !important; }" });
  await sleep(3500 - 1800 - 300); // start just before the first scripted move

  const frames = [];
  const t0 = Date.now();
  while (Date.now() - t0 < TOUR_MS) {
    const png = PNG.sync.read(await page.screenshot());
    frames.push({ t: Date.now() - t0, ...downscale(png.data, png.width, png.height, GIF_WIDTH) });
  }
  await ctx.close();

  const kept = [];
  for (const f of frames) {
    const last = kept[kept.length - 1];
    if (last && changed(last.data, f.data) < 0.002) continue;
    kept.push(f);
  }
  // 255 real colours + one reserved transparent slot: after the first frame, every pixel that
  // didn't change is written as transparent, so each frame only carries what actually moved
  const colors = quantize(paletteSample(kept), 255);
  const CLEAR = colors.length;
  const palette = [...colors, [0, 0, 0]];
  const gif = GIFEncoder();
  let prev = null;
  kept.forEach((f, i) => {
    const idx = applyPalette(f.data, colors);
    let out = idx;
    if (prev) {
      out = new Uint8Array(idx.length);
      for (let k = 0; k < idx.length; k++) out[k] = idx[k] === prev[k] ? CLEAR : idx[k];
    }
    const next = kept[i + 1]?.t ?? TOUR_MS;
    gif.writeFrame(out, f.width, f.height, {
      palette: i === 0 ? palette : undefined,
      delay: Math.max(20, next - f.t),
      repeat: 0,
      transparent: i > 0,
      transparentIndex: CLEAR,
      dispose: 1,
    });
    prev = idx;
  });
  gif.finish();
  await writeFile(OUT + "taxi.gif", gif.bytes());
  return { captured: frames.length, kept: kept.length };
}

await mkdir(OUT, { recursive: true });
const vite = await startVite();
const browser = await chromium.launch({ channel: "chrome" });
try {
  await stills(browser);
  const gif = await tourGif(browser);
  console.log(`screenshots written to docs/screenshots/ (gif: ${gif.kept} of ${gif.captured} frames kept)`);
} finally {
  await browser.close();
  vite.kill();
}
