export function getClientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

export function getRequestId(request: Request) {
  const existing = request.headers.get("x-request-id");
  if (existing && existing.length > 0) {
    return existing;
  }

  return crypto.randomUUID();
}
