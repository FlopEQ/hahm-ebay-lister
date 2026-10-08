import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
let guard: typeof import("@/lib/api-guard").guardApiRequest;
const assetBucket = {bucket:"photo-assets",maxRequests:400};
function request(ip:string,secret?:string) {
  return new NextRequest("http://localhost/api/photo-assets",{headers:{"x-forwarded-for":ip,...(secret ? {"x-app-secret":secret} : {})}});
}
beforeEach(async () => {
  vi.resetModules(); vi.stubEnv("APP_SECRET","test-access-code");
  guard = (await import("@/lib/api-guard")).guardApiRequest;
});
afterEach(() => {vi.unstubAllEnvs();});
describe("authenticated photo asset rate limits", () => {
  it("allows a legitimate photo intake above 40 requests through its authenticated asset bucket", () => {
    const req = request("198.51.100.11","test-access-code");
    for (let n=0;n<300;n++) expect(guard(req,assetBucket)).toBeNull();
  });
  it("keeps ordinary paid requests limited to 40 and separate from asset requests", () => {
    const req = request("198.51.100.12","test-access-code");
    for (let n=0;n<45;n++) expect(guard(req,assetBucket)).toBeNull();
    for (let n=0;n<40;n++) expect(guard(req)).toBeNull();
    expect(guard(req)?.status).toBe(429);
  });
  it("charges unauthenticated attempts to the ordinary limit without consuming authenticated asset allowance", () => {
    const anonymous = request("198.51.100.13","wrong");
    for (let n=0;n<40;n++) expect(guard(anonymous,assetBucket)?.status).toBe(401);
    expect(guard(anonymous,assetBucket)?.status).toBe(429);
    const authenticated = request("198.51.100.13","test-access-code");
    for (let n=0;n<400;n++) expect(guard(authenticated,assetBucket)).toBeNull();
    expect(guard(authenticated,assetBucket)?.status).toBe(429);
  });
});
