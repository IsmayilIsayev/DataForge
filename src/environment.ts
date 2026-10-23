import type { ConnectionEnvironment, ConnectionMeta } from "./types";

export interface EnvironmentOption {
  id: ConnectionEnvironment;
  label: string;
  color: string;
  background: string;
}

export const ENVIRONMENT_OPTIONS: EnvironmentOption[] = [
  {
    id: "dev",
    label: "Dev",
    color: "var(--env-dev)",
    background: "var(--env-dev-bg)",
  },
  {
    id: "test",
    label: "Test",
    color: "var(--env-test)",
    background: "var(--env-test-bg)",
  },
  {
    id: "prod",
    label: "Prod",
    color: "var(--env-prod)",
    background: "var(--env-prod-bg)",
  },
];

export function environmentOption(
  environment: ConnectionEnvironment | undefined,
): EnvironmentOption | undefined {
  return ENVIRONMENT_OPTIONS.find((option) => option.id === environment);
}

export function environmentColor(
  environment: ConnectionEnvironment | undefined,
): string | undefined {
  return environmentOption(environment)?.color;
}

export function isProtectedEnvironment(
  environment: ConnectionEnvironment | undefined,
): boolean {
  return environment === "test" || environment === "prod";
}

export function isProduction(
  connection: ConnectionMeta | null | undefined,
): boolean {
  return connection?.environment === "prod";
}

export function isReadOnly(
  connection: ConnectionMeta | null | undefined,
): boolean {
  return !!connection?.read_only;
}
