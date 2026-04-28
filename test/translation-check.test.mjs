import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTranslationCheck } from "../dist/tools/translation-check.js";

async function createFixtureProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), "magento2-dev-mcp-translation-check-"));
  const moduleDir = join(projectRoot, "vendor", "mageb2b", "sample-module");
  const magentoCoreDir = join(projectRoot, "vendor", "magento", "module-backend");

  await mkdir(join(moduleDir, "i18n"), { recursive: true });
  await mkdir(join(moduleDir, "Block"), { recursive: true });
  await mkdir(join(magentoCoreDir, "i18n"), { recursive: true });

  await writeFile(
    join(moduleDir, "composer.json"),
    JSON.stringify(
      {
        name: "mageb2b/sample-module",
        type: "magento2-module"
      },
      null,
      2
    )
  );

  await writeFile(
    join(moduleDir, "Block", "Example.php"),
    `<?php
declare(strict_types=1);

namespace MageB2B\\SampleModule\\Block;

class Example
{
    public function label(): string
    {
        return __('Custom Phrase');
    }
}
`
  );

  await writeFile(
    join(magentoCoreDir, "i18n", "en_US.csv"),
    `"Status","Status"\n`
  );

  return {
    projectRoot,
    moduleRelativeDir: "vendor/mageb2b/sample-module"
  };
}

async function withFixture(run) {
  const fixture = await createFixtureProject();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.projectRoot, { recursive: true, force: true });
  }
}

async function withProjectRoot(projectRoot, run) {
  const originalCwd = process.cwd();
  process.chdir(projectRoot);
  try {
    await run();
  } finally {
    process.chdir(originalCwd);
  }
}

test("translation-check auto-detects module locales and passes when shipped locale keysets match", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Role Label","Role Label"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "de_DE.csv"),
      `"Custom Phrase","Benutzerdefinierte Phrase"\n"Role Label","Rollenbezeichnung"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, true);
      assert.deepEqual(result.metrics.locales, ["en_US", "de_DE"]);
      assert.deepEqual(result.details?.localeKeysetMismatch, {});
      assert.equal(result.summary.failures, 0);
    });
  });
});

test("translation-check fails when shipped module locales do not share the same keyset", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Role Label","Role Label"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "de_DE.csv"),
      `"Custom Phrase","Benutzerdefinierte Phrase"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.deepEqual(result.metrics.locales, ["en_US", "de_DE"]);
      assert.deepEqual(result.details?.localeKeysetMismatch, {
        de_DE: {
          missingModuleKeys: ["Role Label"]
        }
      });
      assert.match(
        result.messages?.fail.join("\n") ?? "",
        /module locale keyset mismatch/
      );
    });
  });
});

test("translation-check fails on non-canonical CSV quoting", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Role Label",Role Label\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.deepEqual(result.details?.noncanonicalCsvLines, {
        en_US: [
          {
            line: 2,
            raw: "\"Role Label\",Role Label",
            expected: "\"Role Label\",\"Role Label\""
          }
        ]
      });
      assert.match(result.messages?.fail.join("\n") ?? "", /non-canonical CSV quoting/);
    });
  });
});

test("translation-check fails on reserved Magento core phrase collisions", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Status","Status"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.deepEqual(result.details?.coreTranslationCollisions, {
        en_US: [
          {
            key: "Status",
            moduleValue: "Status",
            coreValue: "Status",
            sameValue: true,
            corePackage: "magento/module-backend",
            corePath: join(fixture.projectRoot, "vendor", "magento", "module-backend", "i18n", "en_US.csv"),
            collisionScope: "locale"
          }
        ]
      });
      assert.match(
        result.messages?.fail.join("\n") ?? "",
        /duplicate reserved Magento\/platform phrase keys/
      );
    });
  });
});

test("translation-check fails on placeholder mismatches", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Hello %1","Hallo"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "Block", "Example.php"),
      `<?php
declare(strict_types=1);

namespace MageB2B\\SampleModule\\Block;

class Example
{
    public function label(): string
    {
        return __('Hello %1');
    }
}
`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.equal(result.placeholderIssues.length, 1);
      assert.deepEqual(result.placeholderIssues[0], {
        locale: "en_US",
        key: "Hello %1",
        value: "Hallo",
        line: 2,
        expected: ["%1"],
        actual: []
      });
      assert.match(result.messages?.fail.join("\n") ?? "", /placeholder mismatches/);
    });
  });
});

test("translation-check reports source coverage as warning instead of fail when strictSource is false", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Role Label","Role Label"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({
        moduleDir: fixture.moduleRelativeDir,
        strictSource: false
      });

      assert.equal(result.okTranslations, false);
      assert.equal(result.summary.failures, 1);
      assert.ok(result.summary.warnings > 0);
      assert.deepEqual(result.details?.sourceMissing, ["Custom Phrase"]);
      assert.match(result.messages?.warn.join("\n") ?? "", /source coverage missing 1 phrase/);
      assert.doesNotMatch(result.messages?.fail.join("\n") ?? "", /source coverage missing 1 phrase/);
      assert.match(result.messages?.fail.join("\n") ?? "", /missing\/empty translations found/);
    });
  });
});

test("translation-check fails on untranslated technical labels instead of allowlisting them", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Id","Id"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "de_DE.csv"),
      `"Id","ID"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "Block", "Example.php"),
      `<?php
declare(strict_types=1);

namespace MageB2B\\SampleModule\\Block;

class Example
{
    public function label(): string
    {
        return __('Id');
    }
}
`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.deepEqual(result.details?.untranslatedValues, {
        de_DE: ["Id"]
      });
      assert.match(result.messages?.fail.join("\n") ?? "", /de_DE: untranslated values \(same as source\) in 1 key\(s\)/);
    });
  });
});

test("translation-check uses dependency fallback when source phrase is provided by required mageb2b module", async () => {
  await withFixture(async (fixture) => {
    const dependencyDir = join(fixture.projectRoot, "vendor", "mageb2b", "base-module");
    await mkdir(join(dependencyDir, "i18n"), { recursive: true });
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "composer.json"),
      JSON.stringify(
        {
          name: "mageb2b/sample-module",
          type: "magento2-module",
          require: {
            "mageb2b/base-module": "^1.0"
          }
        },
        null,
        2
      )
    );
    await writeFile(
      join(dependencyDir, "composer.json"),
      JSON.stringify(
        {
          name: "mageb2b/base-module",
          type: "magento2-module"
        },
        null,
        2
      )
    );
    await writeFile(
      join(dependencyDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Role Label","Role Label"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, true);
      assert.equal(result.summary.failures, 0);
      assert.match(result.notes?.join("\n") ?? "", /dependency_fallback_modules=mageb2b\/base-module/);
      assert.match(result.messages?.pass.join("\n") ?? "", /dependency fallback phrases available: 1/);
      assert.deepEqual(result.details?.sourceMissing, []);
    });
  });
});

test("translation-check fails for untranslated same-as-source values", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "Block", "Example.php"),
      `<?php
declare(strict_types=1);

namespace MageB2B\\SampleModule\\Block;

class Example
{
    public function label(): string
    {
        return __('Sublogin');
    }
}
`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Sublogin","Sublogin"\n`
    );
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "de_DE.csv"),
      `"Sublogin","Sublogin"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.deepEqual(result.details?.untranslatedValues, {
        de_DE: ["Sublogin"]
      });
      assert.match(result.messages?.fail.join("\n") ?? "", /untranslated values \(same as source\) in 1 key/);
    });
  });
});

test("translation-check reports duplicate exact keys, normalized duplicates and case-only variants", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n"Alpha","One"\n"Alpha","Two"\n"Role Label","Primary"\n"Role  Label","Secondary"\n"beta","Lower"\n"Beta","Upper"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({ moduleDir: fixture.moduleRelativeDir });

      assert.equal(result.okTranslations, false);
      assert.deepEqual(result.details?.duplicates, {
        en_US: [
          {
            key: "Alpha",
            firstLine: 2,
            line: 3
          }
        ]
      });
      assert.deepEqual(result.details?.normalizedDuplicates, {
        en_US: [
          {
            normalizedKey: "Role Label",
            firstKey: "Role Label",
            firstLine: 4,
            key: "Role  Label",
            line: 5
          }
        ]
      });
      assert.ok(Array.isArray(result.details?.caseVariantKeys?.en_US));
      assert.deepEqual(
        result.details.caseVariantKeys.en_US.find((group) => group.normalizedKeyCasefold === "beta"),
        {
          normalizedKeyCasefold: "beta",
          variants: [
            { key: "beta", line: 6 },
            { key: "Beta", line: 7 }
          ]
        }
      );
      assert.match(result.messages?.fail.join("\n") ?? "", /duplicate exact key entries/);
      assert.match(result.messages?.fail.join("\n") ?? "", /duplicate normalized keys/);
      assert.match(result.messages?.warn.join("\n") ?? "", /key variants differ only by case/);
    });
  });
});

test("translation-check fails when an explicitly requested locale file is missing", async () => {
  await withFixture(async (fixture) => {
    await writeFile(
      join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "en_US.csv"),
      `"Custom Phrase","Custom Phrase"\n`
    );

    await withProjectRoot(fixture.projectRoot, async () => {
      const result = await runTranslationCheck({
        moduleDir: fixture.moduleRelativeDir,
        locales: ["en_US", "de_DE"]
      });

      assert.equal(result.okTranslations, false);
      assert.ok(result.summary.failures > 0);
      assert.equal(result.metrics.locales.length, 2);
      assert.deepEqual(result.missing.find((entry) => entry.reason === "missing_locale_file"), {
        locale: "de_DE",
        key: "*",
        reason: "missing_locale_file",
        file: join(fixture.projectRoot, fixture.moduleRelativeDir, "i18n", "de_DE.csv")
      });
      assert.match(result.messages?.fail.join("\n") ?? "", /missing locale file/);
    });
  });
});
