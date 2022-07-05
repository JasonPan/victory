#!/usr/bin/env node

/**
 * This helper script uses `victory-core` as a template and then for each
 * other victory package as follows.
 *
 * 1. Adds all `scripts` and `wireit` configs to that package.
 * 2. Updates wireit config dependencies to match package.json dependencies.
 *
 * The script also adds `wireit` configs to the root package.json.
 *
 * Note that this script does _not_ mutate:
 * - victory-core
 * - victory-vendor
 * - victory-native
 *
 * If you are editing `victory-vendor` or `victory-native`, directly edit them.
 * For **all other packages**, make your changes in `victory-core` first, test
 * out, and then run this script to sync all the other packages.
 */

const fs = require("fs/promises");
const path = require("path");
const { log, error } = console; // eslint-disable-line no-undef

// ============================================================================
// Config
// ============================================================================
const ROOT = path.resolve(__dirname, ".."); // eslint-disable-line no-undef
const PKGS_ROOT = path.join(ROOT, "packages");

// Special packages
const PKGS = {
  CORE: "victory-core",
  NATIVE: "victory-native",
  VENDOR: "victory-vendor",
};
const SPECIAL_PKGS = new Set([PKGS.CORE, PKGS.NATIVE, PKGS.VENDOR]);

// ============================================================================
// Helpers
// ============================================================================
const readPkg = async (pkgPath) => JSON.parse(await fs.readFile(pkgPath));
const writePkg = async (pkgPath, data, originalPkg) => {
  const json = JSON.stringify(data, null, 2);
  if (json === JSON.stringify(originalPkg, null, 2)) {
    log(`Skipping ${pkgPath} (no changes)`);
    return;
  }
  log(`Writing ${pkgPath}`);
  await fs.writeFile(pkgPath, `${json}\n`);
};
const clone = (obj) => JSON.parse(JSON.stringify(obj));

// Root mutation
//
// We want to use wireit directly to manage multi-build for better
// cache hits (e.g. `pnpm -r run build` seems to get a lot of cache
// misses). So create tasks with cross-package deps
const updateRootPkg = async ({ allPkgs }) => {
  const rootPkgPath = `${ROOT}/package.json`;
  const originalPkg = await readPkg(rootPkgPath);
  const rootPkg = clone(originalPkg);

  rootPkg.wireit = rootPkg.wireit || {};
  [
    { rootTask: "build", pkgTask: "build" },
    { rootTask: "format:pkgs", pkgTask: "format" },
    { rootTask: "lint:pkgs", pkgTask: "lint" },
    { rootTask: "jest:pkgs", pkgTask: "jest" },
    { rootTask: "types:check:pkgs", pkgTask: "types:check" },
  ].forEach(({ rootTask, pkgTask }) => {
    rootPkg.wireit[rootTask] = rootPkg.wireit[rootTask] || {};
    rootPkg.wireit[rootTask].dependencies = allPkgs.map(
      (p) => `./packages/${p}:${pkgTask}`,
    );
  });

  await writePkg(rootPkgPath, rootPkg, originalPkg);
};

// Common library mutations.
//
// Use the core package as the template for the rest.
const updateLibPkgs = async ({ libPkgs }) => {
  const corePkg = await readPkg(`${PKGS_ROOT}/victory-core/package.json`);

  for (const workspace of libPkgs) {
    const pkgPath = `${PKGS_ROOT}/${workspace}/package.json`;
    const originalPkg = await readPkg(pkgPath);
    const pkg = clone(originalPkg);

    // Overwrite scripts and wireit configuration
    pkg.scripts = clone(corePkg.scripts);
    pkg.wireit = clone(corePkg.wireit);

    // Clear out existing deps from victory-core
    // TODO(wireit): Abstract and refactor this whole section better.
    [
      "build:lib:esm",
      "build:lib:cjs",
      "build:dist:dev",
      "build:dist:min",
      "types:check",
    ].forEach((key) => {
      pkg.wireit[key].dependencies = [];
    });

    // Prod dependencies
    const addDeps = (key, dep, task) => {
      // Only add dependencies that (1) aren't self-references, and (2) are unique.
      if (dep !== pkg.name && !pkg.wireit[key].dependencies.includes(task)) {
        pkg.wireit[key].dependencies.push(task);
      }
    };
    const crossDeps = Object.keys(pkg.dependencies).filter((p) =>
      p.startsWith("victory-"),
    );
    crossDeps.forEach((dep) => {
      // Make sure dependent libraries are built.
      addDeps("build:lib:esm", dep, `../${dep}:build:lib:esm`);
      addDeps("build:lib:cjs", dep, `../${dep}:build:lib:cjs`);

      // Webpack depends on ESM output from other packages.
      addDeps("build:dist:dev", dep, `../${dep}:build:lib:esm`);
      addDeps("build:dist:min", dep, `../${dep}:build:lib:esm`);

      // TypeScript checking depends on types output from other packages.
      addDeps("types:check", dep, `../${dep}:types:create`);
    });

    // Dev dependencies
    // We have hidden deps on `victory-voronoi` and `victory-vendor` in
    // test (`test/helpers/svg`). So, we just write the base deps from scratch
    // here.
    pkg.wireit.jest.dependencies = [
      "build:lib:cjs",
      "../victory-voronoi:build:lib:cjs",
      "../victory-vendor:build:lib:cjs",
    ].filter((task) => !task.includes(`/${pkg.name}:`));
    const crossDevDeps = Object.keys(pkg.devDependencies || {}).filter((p) =>
      p.startsWith("victory"),
    );
    crossDevDeps.forEach((dep) => {
      addDeps("jest", dep, `../${dep}:build:lib:cjs`);
    });

    await writePkg(pkgPath, pkg, originalPkg);
  }
};

// ============================================================================
// Script
// ============================================================================
const cli = async () => {
  // Get packages.
  const libPkgs = (await fs.readdir(PKGS_ROOT)).filter(
    (p) => p.startsWith("victory") && !SPECIAL_PKGS.has(p),
  );
  const allPkgs = [...SPECIAL_PKGS, ...libPkgs];

  // Mutate package.json's
  await updateRootPkg({ allPkgs });
  await updateLibPkgs({ libPkgs });

  log("Finished syncing.");
};

if (require.main === module) {
  cli().catch((err) => {
    error(err);
    process.exit(1); // eslint-disable-line no-process-exit
  });
}

module.exports = {
  cli,
};
