import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { prepareListing } from "@/lib/ebay/publish";
import { withDeadline } from "@/lib/network";
import { withAiUsageResponse } from "@/lib/ai-meter";
export const maxDuration = 120;
async function handlePOST(req: NextRequest) {
  const denied = guardApiRequest(req); if (denied) return denied;
  try {
    const body = await req.json();
    const l = body?.listing;
    if (!l || typeof l.title !== "string" || !l.title.trim() || l.title.length > 200 ||
        typeof l.description !== "string" || l.description.length > 15000 ||
        (l.category_id !== undefined && (typeof l.category_id !== "string" || !/^\d{0,20}$/.test(l.category_id))) ||
        (l.item_specifics !== undefined && (!l.item_specifics || typeof l.item_specifics !== "object" || Array.isArray(l.item_specifics) ||
          Object.keys(l.item_specifics).length > 100 || Object.values(l.item_specifics).some(v => typeof v !== "string"))))
      return NextResponse.json({ok:false,error:"Invalid listing data."},{status:400});
    const images = body.images || [];
    if (!Array.isArray(images) || images.length > 4 || images.some(i => !i ||
        !["image/jpeg","image/png","image/webp"].includes(i.mediaType) || typeof i.data !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data) || i.data.length > 2_800_000) ||
        images.reduce((n,i) => n + i.data.length,0) > 3_800_000)
      return NextResponse.json({ok:false,error:"Invalid review photos."},{status:400});
    const token = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
    if (!token) return NextResponse.json({ok:false,error:"Connect your eBay account first."},{status:401});
    const prepared = await withDeadline(90_000, () => prepareListing(token,l,images));
    return NextResponse.json({ok:true,...prepared});
  } catch(e) { return NextResponse.json({ok:false,error:(e as Error).message},{status:422}); }
}

export async function POST(req: NextRequest) {
  return withAiUsageResponse(() => handlePOST(req));
}
