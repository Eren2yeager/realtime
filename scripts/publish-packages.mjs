import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const scope = "@realtimesdk/";

function publishedVersion(fullName) {
  try {
    return execSync(`npm view "${fullName}" version`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

let publishedAny = false;

for (const entry of readdirSync(packagesDir).sort()) {
  const pkgPath = join(packagesDir, entry, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }
  if (pkg.private || !pkg.name?.startsWith(scope) || !pkg.version) continue;
  const fullName = `${pkg.name}@${pkg.version}`;
  if (publishedVersion(fullName) === pkg.version) {
    console.log(`skip ${fullName} (already published)`);
    continue;
  }
  console.log(`publish ${fullName}`);
  execSync(`bun publish --cwd ${join(packagesDir, entry)} --access public --tag latest`, {
    stdio: "inherit",
  });
  publishedAny = true;
}

console.log(publishedAny ? "Published all unpublished packages." : "No packages to publish.");
