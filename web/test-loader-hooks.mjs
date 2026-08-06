import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Mirrors desktop/test-loader-hooks.mjs, trimmed to what web's unit tests
// need: `@/` alias resolution and extensionless relative `.ts` imports.
// Combined with node's `--experimental-strip-types` flag, this lets
// `*.test.mjs` files import the app's real `.ts` source directly — no
// bundler, no compiled fixtures to drift from the source under test.

const srcRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "src",
);

// `nextResolve` requires specifiers to be URLs or relative paths. Passing an
// absolute filesystem path happens to work on POSIX (node coerces it), but on
// Windows an absolute path like `C:\...` parses as a URL with protocol `c:`
// and every test run dies with ERR_UNSUPPORTED_ESM_URL_SCHEME. Hand absolute
// paths to node as proper file:// URLs on all platforms.
function toFileSpecifier(candidatePath) {
  return path.isAbsolute(candidatePath)
    ? pathToFileURL(candidatePath).href
    : candidatePath;
}

function resolveSourcePath(basePath) {
  // Existence decides, not path.extname — a dotted basename looks like an
  // extension but still needs resolving.
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const candidate = path.join(basePath, `index${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const stripped = specifier.slice(2);
    const resolved = resolveSourcePath(`${srcRoot}/${stripped}`);
    return nextResolve(
      toFileSpecifier(resolved ?? `${srcRoot}/${stripped}`),
      context,
    );
  }
  // Resolve extensionless relative TS imports (e.g. `./signers/verify`) —
  // the app's bundler adds the extension, but node's ESM resolver does not.
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    const parentPath = fileURLToPath(context.parentURL);
    const resolved = resolveSourcePath(
      path.resolve(path.dirname(parentPath), specifier),
    );
    if (resolved) {
      return nextResolve(toFileSpecifier(resolved), context);
    }
    return nextResolve(specifier, context);
  }
  return nextResolve(specifier, context);
}
