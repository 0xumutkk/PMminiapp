export const runtime = "nodejs";

const headers = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

export async function GET() {
  return Response.json(
    {
      found: false,
      user: null
    },
    {
      headers
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers
  });
}
