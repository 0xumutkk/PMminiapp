import * as fs from "node:fs/promises";

export const runtime = "nodejs";

const DEBUG_FILE_PATH = "/tmp/pmminiapp-portfolio-ui-debug.json";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const body = await request.json();
    const payload = {
      ...body,
      receivedAt: new Date().toISOString()
    };

    await fs.writeFile(DEBUG_FILE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log("[Portfolio UI Debug]", JSON.stringify(payload));

    return Response.json({ ok: true });
  } catch (error) {
    console.error("[Portfolio UI Debug] Failed to capture payload:", error);
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }
}
