import { createHash } from "node:crypto";
import { validatePublishInput } from "@/lib/ebay/reliability";
import { withDeadline } from "@/lib/network";
import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { fetchAccountSetup, publishListing } from "@/lib/ebay/publish";
import type { PublishInput } from "@/lib/ebay/publish";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: PublishInput;
  try {
    body = (await req.json()) as PublishInput;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  try { validatePublishInput(body); }
  catch (e) { return NextResponse.json({ success:false,error:(e as Error).message },{status:400}); }
  body.accountScope = createHash("sha256").update(req.cookies.get(EBAY_COOKIE)?.value || "").digest("hex");

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { success: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  try {
    const setup = await withDeadline(60_000, () => fetchAccountSetup(accessToken!));
    const result = await publishListing(accessToken, setup, body, { publish: false });
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/draft] unhandled error sku=${body.sku}:`, e);
    return NextResponse.json(
      { success: false, sku: body.sku, error: (e as Error).message },
      { status: 500 }
    );
  }
}
