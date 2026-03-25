import type { MicroClawConfig, SecretgateBoundaryStatus } from "../core/types.js";

function findConfiguredEnv(
  env: NodeJS.ProcessEnv,
  names: string[]
): { name?: string; value?: string } {
  for (const name of names) {
    const value = env[name];
    if (value) {
      return { name, value };
    }
  }

  return {};
}

function normalizeHost(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHost(host));
}

function hostMatchesExpected(host: string, expectedHosts: string[]): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedExpected = expectedHosts.map((item) => normalizeHost(item));

  if (normalizedExpected.includes(normalizedHost)) {
    return true;
  }

  return isLoopbackHost(normalizedHost) && normalizedExpected.some((item) => isLoopbackHost(item));
}

export function inspectSecretgateBoundary(
  config: MicroClawConfig,
  env: NodeJS.ProcessEnv = process.env
): SecretgateBoundaryStatus {
  const proxy = findConfiguredEnv(env, config.security.proxyEnvNames);
  const cert = findConfiguredEnv(env, config.security.certEnvNames);

  if (!proxy.value) {
    return {
      ok: false,
      proxyConfigured: false,
      certConfigured: Boolean(cert.value),
      certEnvName: cert.name,
      certPath: cert.value,
      message: `Missing Secretgate proxy env. Expected one of: ${config.security.proxyEnvNames.join(", ")}.`
    };
  }

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy.value);
  } catch {
    return {
      ok: false,
      proxyConfigured: false,
      certConfigured: Boolean(cert.value),
      proxyEnvName: proxy.name,
      certEnvName: cert.name,
      proxyUrl: proxy.value,
      certPath: cert.value,
      message: `Invalid Secretgate proxy URL in ${proxy.name}.`
    };
  }

  const port = Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80));

  if (!hostMatchesExpected(proxyUrl.hostname, config.security.expectedProxyHosts)) {
    return {
      ok: false,
      proxyConfigured: true,
      certConfigured: Boolean(cert.value),
      proxyEnvName: proxy.name,
      certEnvName: cert.name,
      proxyUrl: proxy.value,
      certPath: cert.value,
      message: `Secretgate proxy must point to ${config.security.expectedProxyHosts.join(", ")}, received ${proxyUrl.hostname}.`
    };
  }

  if (port !== config.security.expectedProxyPort) {
    return {
      ok: false,
      proxyConfigured: true,
      certConfigured: Boolean(cert.value),
      proxyEnvName: proxy.name,
      certEnvName: cert.name,
      proxyUrl: proxy.value,
      certPath: cert.value,
      message: `Secretgate proxy must use port ${config.security.expectedProxyPort}, received ${port}.`
    };
  }

  if (!cert.value) {
    return {
      ok: false,
      proxyConfigured: true,
      certConfigured: false,
      proxyEnvName: proxy.name,
      proxyUrl: proxy.value,
      message: `Missing Secretgate certificate env. Expected one of: ${config.security.certEnvNames.join(", ")}.`
    };
  }

  return {
    ok: true,
    proxyConfigured: true,
    certConfigured: true,
    proxyEnvName: proxy.name,
    certEnvName: cert.name,
    proxyUrl: proxy.value,
    certPath: cert.value,
    message: `Secretgate boundary is active via ${proxy.name} and ${cert.name}.`
  };
}

export function enforceSecretgateBoundary(
  config: MicroClawConfig,
  env: NodeJS.ProcessEnv = process.env
): SecretgateBoundaryStatus {
  const status = inspectSecretgateBoundary(config, env);

  if (config.security.requireSecretgate && !status.ok) {
    throw new Error(
      `${status.message} Start Micro Claw through Secretgate, for example: secretgate wrap -- node dist/cli.js ...`
    );
  }

  return status;
}
