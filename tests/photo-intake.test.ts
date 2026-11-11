import { describe, expect, it, vi } from "vitest";
import { processPhotoIntake } from "@/lib/photo-intake";
const files = (count:number) => Array.from({length:count},(_,index) => new File(["image"],`${index}.jpg`));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise,resolve}; };
describe("bounded photo intake", () => {
  it("limits work to two files and retains input order when completions differ", async () => {
    const gates = Array.from({length:4},deferred);
    const started:number[] = [];
    let active = 0, highest = 0;
    const progress = vi.fn();
    const pending = processPhotoIntake(files(4),async file => {
      const index = Number(file.name.split(".")[0]);
      started.push(index); highest = Math.max(highest,++active);
      await gates[index].promise; active--; return index;
    },progress);
    expect(started).toEqual([0,1]);
    gates[1].resolve(); await vi.waitFor(() => expect(started).toEqual([0,1,2]));
    gates[2].resolve(); await vi.waitFor(() => expect(started).toEqual([0,1,2,3]));
    gates[3].resolve(); gates[0].resolve();
    expect(await pending).toEqual({photos:[0,1,2,3],errors:[]});
    expect(highest).toBe(2);
    expect(progress.mock.calls).toEqual([[1,4],[2,4],[3,4],[4,4]]);
  });
  it("keeps successful photos and reports each failed filename while finishing every file", async () => {
    const progress = vi.fn();
    const result = await processPhotoIntake(files(4),async file => {
      if (file.name === "1.jpg") throw new Error("Could not decode");
      if (file.name === "3.jpg") throw "Not an image";
      return file.name;
    },progress);
    expect(result).toEqual({photos:["0.jpg","2.jpg"],errors:["1.jpg: Could not decode","3.jpg: Not an image"]});
    expect(progress).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenLastCalledWith(4,4);
  });
  it("retains successful undefined values rather than confusing them with failures", async () => {
    expect(await processPhotoIntake(files(1),async () => undefined)).toEqual({photos:[undefined],errors:[]});
  });
  it("handles an empty intake without starting workers", async () => {
    const process = vi.fn(), progress = vi.fn();
    expect(await processPhotoIntake([],process,progress)).toEqual({photos:[],errors:[]});
    expect(process).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
  });
});
