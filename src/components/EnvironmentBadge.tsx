import { environmentOption } from "../environment";
import type { ConnectionEnvironment } from "../types";

interface Props {
  environment?: ConnectionEnvironment;
}

/**
 * Text + colour badge. Production always shows "PROD" so the warning does not
 * depend on colour perception alone.
 */
export default function EnvironmentBadge({ environment }: Props) {
  const option = environmentOption(environment);
  if (!option || (option.id !== "test" && option.id !== "prod")) return null;

  const label = option.id === "prod" ? "PROD" : "TEST";

  return (
    <span
      title={`${label} environment`}
      style={{
        flex: "none",
        padding: "1px 4px",
        border: `1px solid ${option.color}`,
        borderRadius: 3,
        background: option.background,
        color: option.color,
        fontFamily: "var(--mono)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: ".04em",
        lineHeight: 1.5,
      }}
    >
      {label}
    </span>
  );
}
