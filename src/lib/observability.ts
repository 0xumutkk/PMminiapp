type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

function safeSerialize(input: LogContext) {
  try {
    return JSON.stringify(input);
  } catch {
    return JSON.stringify({ message: "Log serialization failed" });
  }
}

export function logEvent(level: LogLevel, event: string, context: LogContext = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...context
  };

  const serialized = safeSerialize(payload);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.info(serialized);
}
