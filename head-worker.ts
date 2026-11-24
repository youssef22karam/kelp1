// Head Tracking, off the main thread: MediaPipe's face detector (BlazeFace, short range), fed one camera frame at a time,
// answering with the face's box and its eyes and how long it took. Everything runs here on the device; nothing is sent
// anywhere. The files are fetched here, counted as they stream in so the page can show real progress, and the WASM is
// compiled and the model loaded here, so none of it holds up the page. The WASM is Bolt's: the same MediaPipe build.
import { FaceDetector, type FaceDetectorResult } from "@mediapipe/tasks-vision";

const BASE = "/assets/21-bolt/mediapipe";
const WASM = `${BASE}/vision_wasm_internal.wasm`;
const MODEL = "/assets/17-kelp/mediapipe/blaze_face_short_range.tflite";
// Sizes to count against if the server does not say.
const SIZES: Record<string, number> = { [WASM]: 14603354, [MODEL]: 229746 };

type Message = { type: "frame"; bitmap: ImageBitmap; time: number } | { type: "init" };

// Frames are handed to the detector as plain pixels read on the CPU here, so MediaPipe never starts a WebGL context of
// its own beside the forest's WebGPU (see Bolt's IRL Hands).
let pixels: OffscreenCanvasRenderingContext2D | null = null;
let detector: FaceDetector | null = null;
let last = 0;

// Both files at once, streamed, the bytes so far posted a few times a second.
async function download() {
  const loaded: Record<string, number> = { [WASM]: 0, [MODEL]: 0 };
  const total: Record<string, number> = { ...SIZES };
  let posted = 0;
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - posted < 100) return;
    posted = now;
    self.postMessage({ type: "progress", stage: "download", loaded: loaded[WASM] + loaded[MODEL], total: total[WASM] + total[MODEL] });
  };
  const fetchOne = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${url.split("/").pop()} could not be downloaded (${response.status})`);
    const length = Number(response.headers.get("content-length"));
    // Ignore a length that is the compressed size of a file sent compressed.
    if (length > 0 && !response.headers.get("content-encoding")) total[url] = length;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded[url] += value.byteLength;
      if (loaded[url] > total[url]) total[url] = loaded[url];
      report();
    }
    const bytes = new Uint8Array(loaded[url]);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  };
  const [wasm, model] = await Promise.all([fetchOne(WASM), fetchOne(MODEL)]);
  report(true);
  return { wasm, model };
}

const start = async () => {
  let stage = "download";
  try {
    const { wasm, model } = await download();
    stage = "start";
    self.postMessage({ type: "progress", stage });
    const wasmUrl = URL.createObjectURL(new Blob([wasm as BlobPart], { type: "application/wasm" }));
    // The CPU delegate: on the GPU it would fight the forest for it.
    detector = await FaceDetector.createFromOptions(
      { wasmLoaderPath: `${BASE}/vision_wasm_internal.js`, wasmBinaryPath: wasmUrl },
      { baseOptions: { modelAssetBuffer: model, delegate: "CPU" }, runningMode: "VIDEO", minDetectionConfidence: 0.5 }
    );
    // One frame through it now, so the first real frame does not pay for setting up.
    detector.detectForVideo(new ImageData(320, 240), ++last);
    self.postMessage({ type: "ready" });
  } catch (error) {
    self.postMessage({ type: "error", stage, message: error instanceof Error ? error.message : String(error) });
  }
};
let ready: Promise<void> | null = null;

self.onmessage = async (event: MessageEvent<Message>) => {
  if (event.data.type === "init") {
    ready ??= start();
    return;
  }
  const { bitmap, time } = event.data;
  await ready;
  if (!detector) {
    bitmap.close();
    return;
  }
  // Video timestamps must only ever increase.
  const stamp = Math.max(time, last + 1);
  last = stamp;
  const began = performance.now();
  let result: FaceDetectorResult | null = null;
  try {
    if (!pixels || pixels.canvas.width !== bitmap.width || pixels.canvas.height !== bitmap.height) {
      pixels = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
    }
    if (pixels) {
      pixels.drawImage(bitmap, 0, 0);
      result = detector.detectForVideo(pixels.getImageData(0, 0, bitmap.width, bitmap.height), stamp);
    }
  } catch {
    result = null;
  }
  const { width, height } = bitmap;
  bitmap.close();
  const ms = performance.now() - began;
  // The most confident face: its box (as shares of the picture) and its eyes (the person's right eye, then left).
  const best = (result?.detections ?? []).slice().sort((a, b) => (b.categories[0]?.score ?? 0) - (a.categories[0]?.score ?? 0))[0];
  const box = best?.boundingBox;
  const face =
    best && box && best.keypoints.length >= 2
      ? {
          box: [box.originX / width, box.originY / height, box.width / width, box.height / height],
          eyes: [best.keypoints[0].x, best.keypoints[0].y, best.keypoints[1].x, best.keypoints[1].y]
        }
      : null;
  self.postMessage({ type: "result", face, ms, time });
};
