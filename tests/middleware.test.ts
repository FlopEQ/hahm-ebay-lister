import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
afterEach(() => {vi.unstubAllEnvs();});
async function configured(production = true) {
  vi.resetModules();vi.stubEnv("NODE_ENV",production ? "production" : "development");vi.stubEnv("VERCEL_ENV",production ? "production" : "development");
  return import("@/middleware");
}
describe("Next.js middleware script nonces", () => {
  it("passes matching CSP and nonce into the SSR request and response",async () => {
    const {middleware} = await configured();
    const response = middleware(new NextRequest("https://example.test/",{headers:{"x-original":"preserved","x-nonce":"untrusted"}}));
    const nonce = response.headers.get("x-middleware-request-x-nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);expect(nonce).not.toBe("untrusted");
    expect(response.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(response.headers.get("content-security-policy"));
    expect(response.headers.get("x-middleware-request-x-original")).toBe("preserved");
    expect(response.headers.get("x-middleware-override-headers")?.split(",")).toEqual(expect.arrayContaining(["content-security-policy","x-nonce"]));
  });
  it("uses a fresh nonce per response and keeps production scripts free of unsafe evaluation",async () => {
    const {middleware} = await configured();
    const first = middleware(new NextRequest("https://example.test/"));
    const second = middleware(new NextRequest("https://example.test/"));
    expect(first.headers.get("x-middleware-request-x-nonce")).not.toBe(second.headers.get("x-middleware-request-x-nonce"));
    const csp = first.headers.get("content-security-policy")!;
    const scripts = csp.split(";").find(directive => directive.trim().startsWith("script-src"))!;
    expect(scripts).not.toContain("unsafe-eval");expect(scripts).not.toContain("unsafe-inline");expect(scripts).toContain("'strict-dynamic'");
    expect(csp).toContain("connect-src 'self'");expect(csp).toContain("frame-src 'none'");expect(csp).toContain("object-src 'none'");
  });
  it("allows evaluation only for development hot reload",async () => {
    const {middleware} = await configured(false);
    expect(middleware(new NextRequest("http://localhost:3001/")).headers.get("content-security-policy")).toContain("'unsafe-eval'");
  });
  it("retains static asset exclusions and prefetch exclusions",async () => {
    const {config} = await configured();
    expect(config.matcher).toEqual([{source:"/((?!_next/static|_next/image|favicon.ico).*)",missing:[
      {type:"header",key:"next-router-prefetch"},{type:"header",key:"purpose",value:"prefetch"},
    ]}]);
    const match = new RegExp(`^${config.matcher[0].source}$`);
    expect(match.test("/")).toBe(true);expect(match.test("/api/analyze")).toBe(true);
    for (const url of ["/_next/static/chunk.js","/_next/image?url=a","/favicon.ico"]) expect(match.test(url)).toBe(false);
  });
});
