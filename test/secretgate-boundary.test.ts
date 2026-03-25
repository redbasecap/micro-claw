import { describe, expect, test } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { inspectSecretgateBoundary } from "../src/security/secretgate-boundary.js";

describe("inspectSecretgateBoundary", () => {
  test("accepts loopback proxy and certificate env vars", () => {
    const status = inspectSecretgateBoundary(defaultConfig, {
      https_proxy: "http://127.0.0.1:8083",
      SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
    });

    expect(status.ok).toBe(true);
    expect(status.proxyConfigured).toBe(true);
    expect(status.certConfigured).toBe(true);
  });

  test("rejects missing certificate env var", () => {
    const status = inspectSecretgateBoundary(defaultConfig, {
      https_proxy: "http://127.0.0.1:8083"
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("Missing Secretgate certificate env");
  });
});
