import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_JAPANESE_MERGE_COUNT = 37;
const CHARACTER_BOUNDS = {
  minX: 0,
  maxX: 1_024,
  minY: -124,
  maxY: 900,
};

function shardKey(character) {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? "0" : Math.floor(codePoint / 256).toString(16);
}

function identityAnimationGroups(strokeCount) {
  return Array.from({ length: strokeCount }, (_, index) => [index]);
}

function matchingEdgePoints(left, right, fromStart) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit) {
    const leftIndex = fromStart ? count : left.length - count - 1;
    const rightIndex = fromStart ? count : right.length - count - 1;
    const leftPoint = left[leftIndex];
    const rightPoint = right[rightIndex];
    if (leftPoint[0] !== rightPoint[0] || leftPoint[1] !== rightPoint[1]) break;
    count += 1;
  }
  return count;
}

function isTechnicalStrokePart(left, right) {
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 3) return false;
  const sharedEdgePoints = Math.max(
    matchingEdgePoints(left, right, true),
    matchingEdgePoints(left, right, false),
  );
  return sharedEdgePoints >= Math.max(3, Math.ceil(shorterLength * .25));
}

function hasImpossibleMedianPoint(median) {
  return median.some(([x, y]) => (
    x < CHARACTER_BOUNDS.minX
    || x > CHARACTER_BOUNDS.maxX
    || y < CHARACTER_BOUNDS.minY
    || y > CHARACTER_BOUNDS.maxY
  ));
}

function detectedJapaneseAnimationGroups(data) {
  if (!Array.isArray(data.strokes) || !Array.isArray(data.medians)) return [];
  const groups = [];
  data.strokes.forEach((_, index) => {
    const previousMedian = data.medians[index - 1];
    const median = data.medians[index];
    if (previousMedian && (
      isTechnicalStrokePart(previousMedian, median)
      || hasImpossibleMedianPoint(median)
    )) {
      groups[groups.length - 1].push(index);
    } else {
      groups.push([index]);
    }
  });
  return groups;
}

function validateManifestGroups(character, groups, strokeCount) {
  if (!Array.isArray(groups) || !groups.length || groups.some((group) => (
    !Array.isArray(group) || !group.length
  ))) {
    throw new Error(`Japanese stroke manifest has empty groups for ${character}.`);
  }
  const flattened = groups.flat();
  if (
    flattened.length !== strokeCount
    || flattened.some((index, position) => index !== position)
  ) {
    throw new Error(
      `Japanese stroke manifest for ${character} must cover ${strokeCount} raw paths exactly once.`,
    );
  }
}

async function loadJapaneseStrokeManifest(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Japanese stroke manifest must be an object.");
  }
  const characters = Object.keys(value);
  if (characters.length !== EXPECTED_JAPANESE_MERGE_COUNT) {
    throw new Error(
      `Japanese stroke manifest must contain ${EXPECTED_JAPANESE_MERGE_COUNT} characters; found ${characters.length}.`,
    );
  }
  return value;
}

async function buildLanguageData(source) {
  const files = (await readdir(source.directory, { withFileTypes: true }))
    .filter((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return false;
      return [...basename(entry.name, ".json")].length === 1;
    })
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const entriesByShard = new Map();
  const strokeManifest = source.strokeManifest
    ? await loadJapaneseStrokeManifest(source.strokeManifest)
    : null;
  const seenManifestCharacters = new Set();

  for (const file of files) {
    const character = basename(file, ".json");
    const raw = await readFile(resolve(source.directory, file), "utf8");
    if (strokeManifest) {
      const data = JSON.parse(raw);
      const detected = detectedJapaneseAnimationGroups(data);
      const expected = strokeManifest[character] ?? identityAnimationGroups(data.strokes.length);
      validateManifestGroups(character, expected, data.strokes.length);
      if (JSON.stringify(detected) !== JSON.stringify(expected)) {
        throw new Error(
          `Japanese stroke merge audit failed for ${character}: expected ${JSON.stringify(expected)}, detected ${JSON.stringify(detected)}.`,
        );
      }
      if (strokeManifest[character]) seenManifestCharacters.add(character);
    }
    const key = shardKey(character);
    const entries = entriesByShard.get(key) ?? [];
    entries.push(`${JSON.stringify(character)}:${raw.trim()}`);
    entriesByShard.set(key, entries);
  }

  if (strokeManifest) {
    const missing = Object.keys(strokeManifest).filter((character) => !seenManifestCharacters.has(character));
    if (missing.length) {
      throw new Error(`Japanese stroke manifest characters are missing from source data: ${missing.join(", ")}.`);
    }
  }

  return {
    characters: files.map((file) => basename(file, ".json")),
    shards: new Map(
      [...entriesByShard.entries()].map(([key, entries]) => [key, `{${entries.join(",")}}`]),
    ),
  };
}

async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(absolutePath, relativePath));
    else if (entry.isFile()) files.push([relativePath, absolutePath]);
  }
  return files;
}

export function strokeDataPlugin() {
  const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const sources = [
    {
      language: "zh",
      directory: resolve(projectRoot, "node_modules", "hanzi-writer-data"),
    },
    {
      language: "ja",
      directory: resolve(projectRoot, "node_modules", "@k1low", "hanzi-writer-data-jp"),
      strokeManifest: resolve(projectRoot, "src", "learning", "japaneseStrokeGroups.json"),
    },
  ];
  const dataPromises = new Map();

  function dataFor(source) {
    const existing = dataPromises.get(source.language);
    if (existing) return existing;
    const next = buildLanguageData(source);
    dataPromises.set(source.language, next);
    return next;
  }

  return {
    name: "meoi-local-stroke-data",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.match(/^\/stroke-data\/catalog\.json(?:\?.*)?$/i)) {
          const catalog = Object.fromEntries(await Promise.all(
            sources.map(async (source) => [source.language, (await dataFor(source)).characters]),
          ));
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(JSON.stringify(catalog));
          return;
        }
        const match = request.url?.match(/^\/stroke-data\/(zh|ja)\/([0-9a-f]+)\.json(?:\?.*)?$/i);
        if (!match) {
          next();
          return;
        }
        const source = sources.find((candidate) => candidate.language === match[1]);
        const shard = source ? (await dataFor(source)).shards.get(match[2].toLocaleLowerCase()) : undefined;
        if (!shard) {
          response.statusCode = 404;
          response.end("Stroke data not found.");
          return;
        }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        response.end(shard);
      });
    },
    async generateBundle() {
      const catalog = {};
      for (const source of sources) {
        const { characters, shards } = await dataFor(source);
        catalog[source.language] = characters;
        for (const [key, contents] of shards) {
          this.emitFile({
            type: "asset",
            fileName: `stroke-data/${source.language}/${key}.json`,
            source: contents,
          });
        }
      }
      this.emitFile({
        type: "asset",
        fileName: "stroke-data/catalog.json",
        source: JSON.stringify(catalog),
      });

      const licenses = [
        ["third-party-licenses/hanzi-writer-LICENSE.txt", resolve(projectRoot, "node_modules", "hanzi-writer", "LICENSE")],
        ["third-party-licenses/hanzi-writer-COPYING.md", resolve(projectRoot, "node_modules", "hanzi-writer", "COPYING.md")],
        ["third-party-licenses/hanzi-writer-data-ARPHICPL.txt", resolve(projectRoot, "node_modules", "hanzi-writer-data", "ARPHICPL.TXT")],
        ["third-party-licenses/hanzi-writer-data-jp-LICENSE.txt", resolve(projectRoot, "node_modules", "@k1low", "hanzi-writer-data-jp", "LICENSE")],
        ...(await filesIn(resolve(projectRoot, "node_modules", "@k1low", "hanzi-writer-data-jp", "licenses")))
          .map(([name, sourcePath]) => [`third-party-licenses/hanzi-writer-data-jp/${name}`, sourcePath]),
      ];
      for (const [fileName, sourcePath] of licenses) {
        this.emitFile({
          type: "asset",
          fileName,
          source: await readFile(sourcePath, "utf8"),
        });
      }
    },
  };
}
