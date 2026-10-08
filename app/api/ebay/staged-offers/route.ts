import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import {
  deleteStagedOffer,
  listStagedOffers,
  publishStagedOffer,
} from "@/lib/ebay/publish";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Action = "list" | "publish" | "delete";

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { action?: Action; offerId?: string };
  try {
    body = (await req.json()) as { action?: Action; offerId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || (body.action && !["list","publish","delete"].includes(body.action)))
    return NextResponse.json({ok:false,error:"Invalid staged-offer action."},{status:400});
  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  try {
    if (!body.action || body.action === "list") {
      return NextResponse.json({ ok: true, offers: await listStagedOffers(accessToken) });
    }
    if (!body.offerId) {
      return NextResponse.json({ ok: false, error: "Missing offer ID." }, { status: 400 });
    }
    const result =
      body.action === "publish"
        ? await publishStagedOffer(accessToken, body.offerId)
        : await deleteStagedOffer(accessToken, body.offerId);
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
