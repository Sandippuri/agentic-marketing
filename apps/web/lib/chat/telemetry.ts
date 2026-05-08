// OpenTelemetry setup. Call `initTelemetry()` once at process start BEFORE
// importing any application code so auto-instrumentation hooks in correctly.
//
// Traces are exported to Grafana Cloud (or any OTLP-compatible backend) via
// OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_HEADERS.
//
// The OTel packages are optional — if not yet installed (pre-production),
// initTelemetry() is a no-op and withSpan() runs `fn` directly.

/* eslint-disable @typescript-eslint/no-explicit-any */

let _tracer: any = null;
let _SpanStatusCode: { OK: number; ERROR: number } = { OK: 1, ERROR: 2 };
let _otelAvailable = false;

export function initTelemetry() {
  if (_otelAvailable) return;
  try {
    // Resolve `require` through `eval` so webpack/Next can't statically see
    // these specifiers and emit "Module not found" warnings when the optional
    // OTel packages aren't installed yet.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
    const dynamicRequire = eval("require") as NodeRequire;
    const { NodeSDK } = dynamicRequire("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = dynamicRequire("@opentelemetry/exporter-trace-otlp-http");
    const { Resource } = dynamicRequire("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = dynamicRequire("@opentelemetry/semantic-conventions");
    const otelApi = dynamicRequire("@opentelemetry/api");
    _SpanStatusCode = otelApi.SpanStatusCode;

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? Object.fromEntries(
            process.env.OTEL_EXPORTER_OTLP_HEADERS.split(",").map((h: string) => h.split("=")),
          )
        : undefined,
    });

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]: "marketing-manager",
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
      }),
      traceExporter: exporter,
    });
    sdk.start();

    _tracer = otelApi.trace.getTracer("marketing-manager");
    _otelAvailable = true;
  } catch {
    // OTel packages not installed yet — tracing is a no-op.
  }
}

/**
 * Run `fn` inside a named OTel span. If OTel is not available, `fn` runs
 * without instrumentation so callers are never impacted by missing packages.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!_otelAvailable || !_tracer) return fn();

  return _tracer.startActiveSpan(name, async (span: any) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    try {
      const result = await fn();
      span.setStatus({ code: _SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: _SpanStatusCode.ERROR, message: (err as Error).message });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
