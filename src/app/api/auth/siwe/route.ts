import { POST as legacyPost } from "@/app/api/auth/siwf/route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return legacyPost(request);
}
