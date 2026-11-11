import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BASE64_CHARS, resizeImage } from "@/lib/resize";
import { rotateImageData, rotateUploadImageData } from "@/lib/rotateImage";

let sourceWidth: number, sourceHeight: number;
let close: ReturnType<typeof vi.fn>;
let noContext: boolean;
let encode: (width: number, height: number, quality: number) => string;
let canvases: { width: number; height: number; quality?: number; rotation?: number; drawArgs?: unknown[]; events: string[] }[];
beforeEach(() => {
  sourceWidth = 4000; sourceHeight = 3000; noContext = false;
  close = vi.fn(); canvases = [];
  encode = (w,h,q) => `data:image/jpeg;base64,${w}_${h}_${q}`;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: sourceWidth, height: sourceHeight, close })));
  vi.stubGlobal("document", { createElement: vi.fn(() => {
    const canvas = { width: 0, height: 0, quality: undefined as number | undefined,
      rotation: undefined as number | undefined, drawArgs: undefined as unknown[] | undefined,
      events: [] as string[],
      getContext: () => noContext ? null : { fillStyle: "", fillRect(x:number,y:number,w:number,h:number) { canvas.events.push(`fill:${this.fillStyle}:${x}:${y}:${w}:${h}`); },
        translate: () => canvas.events.push("translate"), rotate: (r:number) => { canvas.rotation = r; },
        drawImage: (...args:unknown[]) => { canvas.drawArgs = args; canvas.events.push("draw"); } },
      toDataURL: (_type:string, quality:number) => { canvas.quality = quality; return encode(canvas.width,canvas.height,quality); } };
    canvases.push(canvas); return canvas;
  }) });
  vi.stubGlobal("Image", class {
    width = sourceWidth; height = sourceHeight;
    onload?: () => void; onerror?: () => void;
    set src(_value:string) { this.onload?.(); }
  });
});
afterEach(() => vi.unstubAllGlobals());
const file = () => new File(["photo"],"photo.jpg",{type:"image/jpeg"});
const image = { mediaType: "image/jpeg", data: "original" };

describe("photo derivatives", () => {
  it("keeps small AI and sorting images and adds a separate high resolution upload", async () => {
    const result = await resizeImage(file());
    expect(result.data).toBe("1024_768_0.82");
    expect(result.previewUrl).toBe("data:image/jpeg;base64,360_270_0.5");
    expect(result.uploadData).toBe("2400_1800_0.9");
    for (const canvas of canvases) expect(canvas.events[0]).toBe(`fill:#ffffff:0:0:${canvas.width}:${canvas.height}`);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("never enlarges a smaller original", async () => {
    sourceWidth = 300; sourceHeight = 200;
    await resizeImage(file());
    expect(canvases.map(c => [c.width,c.height])).toEqual([[300,200],[300,200],[300,200]]);
  });
  it("reduces dimensions and quality until the upload fits the exact payload budget", async () => {
    encode = (w,h,q) => `data:image/jpeg;base64,${q === 0.9 || q === 0.8 ? "a".repeat(MAX_UPLOAD_BASE64_CHARS + 1) : `${w}_${h}_${q}`}`;
    const result = await resizeImage(file());
    expect(result.uploadData).toBe("1600_1200_0.75");
    expect(canvases.slice(2).map(c => [c.width,c.height,c.quality])).toEqual([[2400,1800,0.9],[2000,1500,0.8],[1600,1200,0.75]]);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("rejects a photo that cannot fit after every fallback and still closes its bitmap", async () => {
    encode = () => `data:image/jpeg;base64,${"a".repeat(MAX_UPLOAD_BASE64_CHARS + 1)}`;
    await expect(resizeImage(file())).rejects.toThrow(/too large/i);
    expect(canvases).toHaveLength(7);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("closes the decoded bitmap when canvas processing fails", async () => {
    noContext = true;
    await expect(resizeImage(file())).rejects.toThrow(/process/i);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("bounded upload rotation", () => {
  it.each([[90,1800,2400], [180,2400,1800], [270,1800,2400], [-90,1800,2400]])("rotates %s degrees with correct output dimensions", async (degrees,width,height) => {
    const result = await rotateUploadImageData(image,degrees);
    expect(result.mediaType).toBe("image/jpeg");
    expect(canvases[0]).toMatchObject({width,height});
    expect(canvases[0].rotation).toBe((((degrees % 360) + 360) % 360) * Math.PI / 180);
    expect(result.data.length).toBeLessThanOrEqual(MAX_UPLOAD_BASE64_CHARS);
  });
  it("keeps rotated uploads within the payload cap after encoding expands", async () => {
    encode = (w,h,q) => `data:image/jpeg;base64,${q > 0.75 ? "a".repeat(MAX_UPLOAD_BASE64_CHARS + 1) : `${w}_${h}_${q}`}`;
    expect((await rotateUploadImageData(image,90)).data).toBe("1200_1600_0.75");
  });
  it("recompresses an oversized JPEG even when its rotation is zero", async () => {
    const result = await rotateUploadImageData({ ...image, data: "a".repeat(MAX_UPLOAD_BASE64_CHARS + 1) },0);
    expect(result.data).toBe("2400_1800_0.9");
  });
  it.each([45,Infinity,NaN])("rejects invalid rotation %s before processing", async degrees => {
    await expect(rotateUploadImageData(image,degrees)).rejects.toThrow(/90 degrees/i);
    await expect(rotateImageData(image,degrees)).rejects.toThrow(/90 degrees/i);
    expect(canvases).toHaveLength(0);
  });
  it("fails instead of silently returning an unrotated image when no canvas context exists", async () => {
    noContext = true;
    await expect(rotateUploadImageData(image,90)).rejects.toThrow();
    await expect(rotateImageData(image,90)).rejects.toThrow();
  });
  it("fills rotated JPEGs white before transforming or drawing transparent pixels", async () => {
    await rotateUploadImageData(image,90);
    await rotateImageData(image,90);
    for (const canvas of canvases) {
      expect(canvas.events[0]).toBe(`fill:#ffffff:0:0:${canvas.width}:${canvas.height}`);
      expect(canvas.events.slice(1)).toEqual(["translate","draw"]);
    }
  });
});
