function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function versionParts(value: string) {
  return normalizeVersion(value)
    .split(/[+-]/, 1)[0]
    .split(".")
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
}

export function compareVersions(a: string, b: string) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  return 0;
}

export function parseVersionSection(changelog: string, version: string) {
  const wanted = normalizeVersion(version);
  if (!wanted) return null;

  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(`^##\\s*\\[${escapeRegExp(wanted)}\\]`);
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return null;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  return lines.slice(start + 1, end).join("\n").trim();
}
