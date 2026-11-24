// Head Tracking: the camera finds your face, and the screen becomes a window into the scene (Kelp, Pendulum): move your head and the
// view shifts as it would through glass. Loaded only when the setting is turned on; the camera is asked for then and
// released when it is turned off. The detector runs in a worker on this device, about 30 times a second, and only the
// latest answer is read by the render loop, so it never waits on it. Nothing is uploaded. Built on Bolt's IRL Hands.

// The live camera with the face's box and eyes, bottom right (above Kelp's sun dial). A plain <video> mirrored by CSS with a
// small canvas over it, redrawn only when a new answer arrives. Set false to hide it.
export const SHOW_DEBUG = true;

// How wide each camera frame is when sent to the detector (BlazeFace works on a 128 px picture anyway), and how often.
const WIDTH = 320;
const RATE = 30;
// A typical webcam's field of view across, and the distance between a person's eyes, to turn the picture into metres.
const CAMERA_FOV = (60 * Math.PI) / 180;
const EYES_APART = 0.063;
// The head's position when tracking starts, averaged over this long, is where the view is as it was.
const SETTLE = 0.6;
// A face missing for this long counts as gone, and the view eases home.
const LOST = 0.4;

// One Euro filter (Casiez et al.): steady when still, quick when moving.
class OneEuro {
  private x = NaN;
  private dx = 0;
  constructor(
    private minCutoff = 1.2,
    private beta = 0.4,
    private dCutoff = 1
  ) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, dt: number) {
    if (Number.isNaN(this.x) || dt <= 0) {
      this.x = value;
      return value;
    }
    const raw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (raw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

type Face = { box: number[]; eyes: number[] };

export type Head = {
  // Where the head is from where it settled, in metres: x to the person's right, y up, z away from the screen.
  offset: { x: number; y: number; z: number };
  // Whether a face is in view now.
  seen: boolean;
  stop: () => void;
  stats: { sent: number; answered: number; inference: number; distance: number };
};

const reason = (error: unknown) => {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Head Tracking needs the camera, and permission was not given.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Head Tracking needs a camera, and none was found.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  return "Head Tracking could not start the camera here.";
};

// The tracker: one worker, which fetches, compiles and starts MediaPipe off the main thread. Kept a minute after Head
// Tracking is turned off, so turning it on again is instant; the files stay in the browser's cache beyond that.
type Tracker = {
  worker: Worker;
  ready: boolean;
  failed: string;
  stage: string;
  loaded: number;
  total: number;
  listen: ((data: { type: string; [key: string]: unknown }) => void) | null;
  idle: number;
};
const KEEP = 60_000;
let kept: Tracker | null = null;

function tracker(): Tracker {
  if (kept && !kept.failed) {
    window.clearTimeout(kept.idle);
    return kept;
  }
  const worker = new Worker(new URL("./head-worker.ts", import.meta.url));
  worker.postMessage({ type: "init" });
  const t: Tracker = { worker, ready: false, failed: "", stage: "download", loaded: 0, total: 0, listen: null, idle: 0 };
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === "progress") {
      t.stage = data.stage;
      if (data.stage === "download") {
        t.loaded = data.loaded;
        t.total = data.total;
      }
    } else if (data.type === "ready") t.ready = true;
    else if (data.type === "error") t.failed = data.stage === "download" ? "The face tracker could not be downloaded." : "The face tracker could not start here.";
    t.listen?.(data);
  };
  worker.onerror = () => {
    t.failed = "The face tracker could not start here.";
    t.listen?.({ type: "error" });
  };
  kept = t;
  return t;
}

function release(t: Tracker) {
  t.listen = null;
  window.clearTimeout(t.idle);
  t.idle = window.setTimeout(() => {
    t.worker.terminate();
    if (kept === t) kept = null;
  }, KEEP);
}

// Where the HUD lives, so what is added here picks up its colours and type.
const root = () => document.querySelector(".cv-root") ?? document.body;

// "Setting up head tracking": a small card in the HUD's own glass, with a spinner, the stage, and a real progress bar.
// Fades away once the first frame is tracked; says plainly what went wrong.
function setupCard() {
  const card = document.createElement("div");
  card.setAttribute("role", "status");
  Object.assign(card.style, {
    position: "fixed",
    left: "50%",
    bottom: "calc(max(16px, env(safe-area-inset-bottom)) + 96px)",
    transform: "translateX(-50%)",
    width: "min(300px, calc(100vw - 32px))",
    padding: "14px 18px 16px",
    borderRadius: "16px",
    border: "1px solid var(--cv-line)",
    background: "var(--cv-glass)",
    backdropFilter: "blur(16px)",
    webkitBackdropFilter: "blur(16px)",
    color: "var(--cv-ink)",
    fontSize: "12px",
    zIndex: "30",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.3s var(--cv-ease)"
  });
  const title = document.createElement("div");
  title.textContent = "Setting up head tracking";
  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "11px", color: "var(--cv-dim)" });
  const spinner = document.createElement("span");
  spinner.className = "cv-spinner";
  const label = document.createElement("span");
  row.append(spinner, label);
  const track = document.createElement("div");
  track.className = "cv-loader-track";
  Object.assign(track.style, { width: "100%", marginTop: "12px" });
  const bar = document.createElement("span");
  bar.style.transform = "scaleX(0)";
  bar.style.transition = "transform 0.4s var(--cv-ease)";
  track.append(bar);
  card.append(title, row, track);
  root().appendChild(card);
  requestAnimationFrame(() => (card.style.opacity = "1"));
  let gone = false;
  const remove = (after: number) => {
    if (gone) return;
    gone = true;
    window.setTimeout(() => (card.style.opacity = "0"), after);
    window.setTimeout(() => card.remove(), after + 350);
  };
  return {
    show(text: string, fraction: number) {
      if (gone) return;
      if (label.textContent !== text) label.textContent = text;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction)).toFixed(3)})`;
    },
    done() {
      if (gone) return;
      bar.style.transform = "scaleX(1)";
      spinner.remove();
      label.textContent = "Ready: move your head to look around";
      remove(900);
    },
    fail(text: string) {
      if (gone) return;
      spinner.remove();
      track.remove();
      title.textContent = "Head tracking could not start";
      label.textContent = text;
      label.style.color = "var(--cv-accent)";
      remove(4500);
    },
    remove: () => remove(0)
  };
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

// Starts the camera and the tracker, showing how far along it is. Resolves once the camera is on (the tracker may still
// be starting). Rejects with a plain message if the camera is refused or missing; a tracker that fails later calls
// onFail. Aborting cleans up whatever has been started.
export async function startHead({ signal, onFail, above }: { signal: AbortSignal; onFail: (message: string) => void; above?: string }): Promise<Head> {
  const card = setupCard();
  // Fetching and starting the tracker begins at once, alongside the camera permission.
  const t = tracker();
  let cameraOn = false;
  let first = false;
  const paint = () => {
    const downloaded = t.ready || t.stage !== "download" ? 1 : t.total > 0 ? t.loaded / t.total : 0;
    const fraction = (cameraOn ? 0.05 : 0) + downloaded * 0.7 + (t.stage === "start" || t.ready ? 0.1 : 0) + (t.ready ? 0.1 : 0);
    const text = !cameraOn
      ? "Asking for the camera"
      : t.ready
        ? "Looking for your face"
        : t.stage === "start"
          ? "Starting the tracker"
          : `Downloading the tracker · ${mb(t.loaded)} of ${mb(t.total || 14.2 * 1048576)} MB`;
    card.show(text, fraction);
  };
  let onData: (data: { type: string; [key: string]: unknown }) => void = () => paint();
  t.listen = (data) => {
    if (data.type === "error") {
      card.fail(t.failed);
      onFail(t.failed);
      return;
    }
    onData(data);
  };
  paint();
  if (t.failed) {
    card.fail(t.failed);
    release(t);
    throw new Error(t.failed);
  }

  const cancel = () => {
    card.remove();
    release(t);
    return new DOMException("Turned off", "AbortError");
  };
  if (!navigator.mediaDevices?.getUserMedia) {
    const message = "Head Tracking needs a camera, and this browser offers none here.";
    card.fail(message);
    release(t);
    throw new Error(message);
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (error) {
    if (signal.aborted) throw cancel();
    card.fail(reason(error));
    release(t);
    throw new Error(reason(error));
  }
  if (signal.aborted) {
    for (const track of stream.getTracks()) track.stop();
    throw cancel();
  }
  cameraOn = true;
  paint();

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.play().catch(() => {
    // Some browsers resolve play() late; frames still arrive.
  });

  let stopped = false;
  let busy = false;
  let fresh = true;
  let lastSent = 0;
  const answers: number[] = [];
  const result: Head = { offset: { x: 0, y: 0, z: 0 }, seen: false, stop: () => {}, stats: { sent: 0, answered: 0, inference: 0, distance: 0 } };
  let face: Face | null = null;
  let seenAt = -Infinity;
  // Across and up: steady when still, following when moved. Distance: much steadier still, since it comes from the few
  // pixels between the eyes, and a wobble in it would wobble the view in and out.
  const filters = [new OneEuro(0.5, 1.5), new OneEuro(0.5, 1.5), new OneEuro(0.12, 0.3)];
  let filteredAt = 0;
  // Where the head settled when tracking began, summed until SETTLE has passed.
  const settle = { from: -1, n: 0, x: 0, y: 0, z: 0, done: false };

  // The panel: the picture as in a mirror, the face's box and eyes over it.
  const panel = SHOW_DEBUG ? document.createElement("div") : null;
  const canvas = SHOW_DEBUG ? document.createElement("canvas") : null;
  const label = SHOW_DEBUG ? document.createElement("div") : null;
  if (panel && canvas && label) {
    Object.assign(panel.style, {
      position: "fixed",
      right: "20px",
      bottom: "96px",
      width: "300px",
      borderRadius: "10px",
      overflow: "hidden",
      background: "#000",
      boxShadow: "0 6px 24px rgba(0, 0, 0, 0.45)",
      zIndex: "40",
      pointerEvents: "none"
    });
    Object.assign(video.style, { display: "block", width: "100%", transform: "scaleX(-1)", opacity: "0.85" });
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%" });
    Object.assign(label.style, {
      position: "absolute",
      left: "6px",
      bottom: "4px",
      right: "6px",
      color: "#e6f6ff",
      font: "500 10px/1.2 ui-monospace, monospace",
      textShadow: "0 1px 2px #000"
    });
    label.textContent = "Head Tracking: loading tracker";
    panel.append(video, canvas, label);
    root().appendChild(panel);
  }
  // 300 px wide where there is room, smaller in a narrow window, and stood just above `above` if the day names one. Again on resize.
  let panelWidth = 300;
  const place = () => {
    if (!panel) return;
    panelWidth = Math.round(Math.max(150, Math.min(300, window.innerWidth * 0.25)));
    panel.style.width = `${panelWidth}px`;
    const dial = above ? document.querySelector(above)?.getBoundingClientRect() : undefined;
    panel.style.bottom = dial && dial.height > 0 ? `${Math.round(window.innerHeight - dial.top + 12)}px` : "96px";
    fresh = true;
  };
  window.addEventListener("resize", place);
  const placing = window.setInterval(place, 1000);
  requestAnimationFrame(place);

  // A face in the picture to metres from the camera: its distance from how far apart the eyes look, then across and up
  // from where between the eyes falls.
  const take = (found: Face | null, now: number) => {
    face = found;
    if (!found) {
      if (now - seenAt > LOST) result.seen = false;
      return;
    }
    const aspect = (video.videoWidth || 640) / Math.max(1, video.videoHeight || 480);
    const across = Math.tan(CAMERA_FOV / 2);
    const up = across / aspect;
    const [rx, ry, lx, ly] = found.eyes;
    const apart = Math.hypot(lx - rx, (ly - ry) / aspect);
    const z = EYES_APART / Math.max(1e-3, apart * 2 * across);
    const dt = filteredAt > 0 && now - seenAt < LOST ? now - filteredAt : 0;
    filteredAt = now;
    seenAt = now;
    const fz = filters[2].filter(z, dt);
    // Where the face is: halfway between the eyes' midpoint and the box's middle, each jittering on its own, so they
    // steady each other. Turned to metres by the smoothed distance, so its wobble stays out. Unmirrored: moving to your
    // right moves your face left in the picture.
    const [bx, by, bw, bh] = found.box;
    const cx = ((rx + lx) / 2 + bx + bw / 2) / 2;
    const cy = ((ry + ly) / 2 + by + bh / 2) / 2;
    const fx = filters[0].filter(-(cx - 0.5) * 2 * across * fz, dt);
    const fy = filters[1].filter(-(cy - 0.5) * 2 * up * fz, dt);
    result.stats.distance = fz;
    if (!settle.done) {
      if (settle.from < 0) settle.from = now;
      settle.n++;
      settle.x += fx;
      settle.y += fy;
      settle.z += fz;
      if (now - settle.from >= SETTLE) {
        settle.done = true;
        settle.x /= settle.n;
        settle.y /= settle.n;
        settle.z /= settle.n;
      }
      return;
    }
    result.offset.x = fx - settle.x;
    result.offset.y = fy - settle.y;
    result.offset.z = fz - settle.z;
    result.seen = true;
  };

  onData = (data) => {
    if (data.type === "result") {
      busy = false;
      result.stats.answered++;
      result.stats.inference = data.ms as number;
      const now = performance.now();
      answers.push(now);
      while (answers.length && answers[0] < now - 1000) answers.shift();
      take(data.face as Face | null, now / 1000);
      fresh = true;
      if (!first) {
        first = true;
        card.done();
      }
    } else if (!first) paint();
  };

  // A frame at a time, at most RATE a second, never more than one in flight.
  let handle = 0;
  const pump = () => {
    if (stopped) return;
    const now = performance.now();
    // Dev only: a scripted face instead of the camera's, for testing without one.
    const feed = process.env.NODE_ENV !== "production" ? (globalThis as { __kelpHeadFeed?: (t: number) => Face | null }).__kelpHeadFeed : undefined;
    if (feed && now - lastSent >= 1000 / RATE) {
      lastSent = now;
      take(feed(now / 1000), now / 1000);
      fresh = true;
      if (!first) {
        first = true;
        card.done();
      }
    }
    if (now / 1000 - seenAt > LOST) result.seen = false;
    if (!feed && !busy && t.ready && video.readyState >= 2 && video.videoWidth > 0 && now - lastSent >= 1000 / RATE - 2) {
      busy = true;
      lastSent = now;
      const scale = Math.min(1, WIDTH / Math.max(1, video.videoWidth));
      createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale), resizeQuality: "low" }).then(
        (bitmap) => {
          if (stopped) {
            bitmap.close();
            return;
          }
          result.stats.sent++;
          t.worker.postMessage({ type: "frame", bitmap, time: now }, [bitmap]);
        },
        () => (busy = false)
      );
    }
    if (fresh) {
      fresh = false;
      draw();
    }
    handle = requestAnimationFrame(pump);
  };
  handle = requestAnimationFrame(pump);

  const draw = () => {
    if (!canvas || !label) return;
    const w = Math.round(panelWidth * Math.min(2, window.devicePixelRatio || 1));
    const h = Math.round((w * (video.videoHeight || 480)) / (video.videoWidth || 640));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    if (face) {
      // Mirrored, as the video is.
      const [bx, by, bw, bh] = face.box;
      g.strokeStyle = result.seen ? "rgba(140, 230, 255, 0.95)" : "rgba(140, 230, 255, 0.45)";
      g.lineWidth = w / 200;
      g.strokeRect((1 - bx - bw) * w, by * h, bw * w, bh * h);
      const [rx, ry, lx, ly] = face.eyes;
      g.fillStyle = "#ffffff";
      for (const [x, y] of [
        [rx, ry],
        [lx, ly]
      ]) {
        g.beginPath();
        g.arc((1 - x) * w, y * h, w / 90, 0, Math.PI * 2);
        g.fill();
      }
    }
    const o = result.offset;
    const status =
      t.failed ||
      (t.ready
        ? `${answers.length} Hz · ${result.stats.inference.toFixed(1)} ms · ${face ? `${result.stats.distance.toFixed(2)} m · ${(o.x * 100).toFixed(0)}, ${(o.y * 100).toFixed(0)}, ${(o.z * 100).toFixed(0)} cm` : "no face"}`
        : "loading tracker");
    label.textContent = `Head Tracking: ${status}`;
  };

  result.stop = () => {
    stopped = true;
    cancelAnimationFrame(handle);
    card.remove();
    release(t);
    for (const track of stream.getTracks()) track.stop();
    video.pause();
    video.srcObject = null;
    panel?.remove();
    window.clearInterval(placing);
    window.removeEventListener("resize", place);
    result.seen = false;
  };
  return result;
}
