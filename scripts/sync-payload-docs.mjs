import fs from "node:fs/promises";
import matter from "gray-matter";
import path from "node:path";

const exportToken = process.env.PAYLOAD_EXPORT_TOKEN;
const payloadDocsUrl = process.env.PAYLOAD_DOCS_URL;
const overwrite = process.env.PAYLOAD_DOCS_OVERWRITE === "1";
// A generated document that is no longer exported by Payload is stale.
// Set PAYLOAD_DOCS_PRUNE=0 only when a build must retain stale output temporarily.
const prune = process.env.PAYLOAD_DOCS_PRUNE !== "0";

if (!payloadDocsUrl) {
  console.log("[payload-docs] PAYLOAD_DOCS_URL is not set; skipping sync.");
  process.exit(0);
}

const locales = ["ko", "en", "es"];
const projectRoot = process.cwd();
const contentRoot = path.join(projectRoot, "content");
const generateMarker = "payloadGenerated: true";

function safeSegment(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`Invalid document path segment: ${String(value)}`);
  }

  return value;
}

function outputPathSegment(value) {
  const segment = safeSegment(value);

  // Legacy documents include `Scope 3` as a literal directory name. URLs with
  // that space do not match the site's canonical docs routes, so normalize the
  // generated artifact only; keep Payload's sourcePath as the migration key.
  if (segment.toLowerCase() === "scope 3") return "scope-3";

  return segment;
}

function outputSegments(doc, locale) {
  if (typeof doc.sourcePath === "string" && doc.sourcePath) {
    const prefix = `${locale}/docs/`;
    if (!doc.sourcePath.startsWith(prefix)) {
      throw new Error(
        `[payload-docs] sourcePath locale mismatch: ${doc.sourcePath}`,
      );
    }

    const relativePath = doc.sourcePath
      .slice(prefix.length)
      .replace(/\.mdx?$/i, "");

    return relativePath.split("/").map(outputPathSegment);
  }

  // Documents authored directly in Payload have no legacy source path.
  return [
    ...(doc.parent ? [safeSegment(doc.parent)] : []),
    safeSegment(doc.slug),
  ];
}

function outputExtension() {
  // CMS-generated documents use one canonical extension. This prevents a
  // legacy `.md` file and generated `.mdx` file from producing the same slug.
  return ".mdx";
}

function toImportPath(fromDirectory, targetWithoutExtension) {
  const relative = path
    .relative(fromDirectory, targetWithoutExtension)
    .replaceAll("\\", "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function restoreEscapedCodeFences(mdx) {
  const escapedFence = String.fromCharCode(92, 96, 92, 96, 92, 96);
  const fence = ["`", "`", "`"].join("");

  return (
    mdx
      .split("\n")
      // Lexical's Markdown export encodes fenced code delimiters as literal text.
      // Restore only a whole-line fence, so LaTex braces remain inside a real code block.
      .map((line) =>
        line.startsWith(escapedFence)
          ? `${fence}${line.slice(escapedFence.length)}`
          : line,
      )
      .join("\n")
  );
}

function normalizeBlockMdx(mdx) {
  return (
    mdx
      // Legacy MDX sometimes prefixes a component with an invisible zero-width
      // space. MDX then treats the component as inline content and puts its
      // rendered <div> inside a paragraph, causing a hydration error.
      .replaceAll("\u200B", "")
      // These components render block-level markup, so they must always occupy
      // their own MDX block even when legacy content placed them after text.
      .replace(
        /<CaptionedImage\b[\s\S]*?\/>/g,
        // Lexical escapes underscores when it serializes an MDX attribute. In an
        // image URL that backslash becomes part of the requested path, so remove
        // the escape while emitting this known component.
        (component) => `\n\n${component.trim().replaceAll("\\_", "_")}\n\n`,
      )
      .replace(
        /<Callout\b[^>]*>[\s\S]*?<\/Callout>/g,
        (component) => `\n\n${component.trim()}\n\n`,
      )
  );
}

async function pruneGeneratedDocuments(directory, expectedPaths) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await pruneGeneratedDocuments(filePath, expectedPaths);
      continue;
    }

    if (!/\.mdx?$/.test(entry.name) || expectedPaths.has(filePath)) continue;

    const content = await fs.readFile(filePath, "utf-8");
    if (!content.includes(generateMarker)) continue;

    await fs.unlink(filePath);
    console.log(
      `[payload-docs] removed ${path.relative(projectRoot, filePath)}`,
    );
  }
}

async function getDocuments(locale) {
  const url = new URL(payloadDocsUrl);
  url.searchParams.set("locale", locale);

  const response = await fetch(url, {
    headers: {
      ...(exportToken ? { Authorization: `Berear ${exportToken}` } : {}),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? {
            "x-vercel-protection-bypass":
              process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          }
        : {}),
    },
  });

  if (!response.ok) {
    throw new Error(
      `[payload-docs] ${locale} export failed: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();

  if (!Array.isArray(payload.docs)) {
    throw new Error(`[payload-docs] Invalid response for locale "${locale}."`);
  }
  return payload.docs;
}

function createMdx({ doc, locale, outputDirectory }) {
  const imports = [];

  if (/<CaptionedImage\b/.test(doc.mdx)) {
    const captionedImage = path.join(
      contentRoot,
      locale,
      "src",
      "components",
      "theme",
      "CaptionedImage",
    );

    imports.push(
      `import CaptionedImage from ${JSON.stringify(toImportPath(outputDirectory, captionedImage))};`,
    );
  }

  if (/<Callout\b/.test(doc.mdx)) {
    imports.push(`import {Callout} from 'fumadocs-ui/components/callout';`);
  }

  const frontmatter = {
    ...(doc.sourceMetadata && typeof doc.sourceMetadata === "object"
      ? doc.sourceMetadata
      : {}),
    title: doc.title,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.tags?.length ? { tags: doc.tags } : {}),
    payloadGenerated: true,
  };
  return matter.stringify(
    `${imports.join("\n")}\n\n${normalizeBlockMdx(restoreEscapedCodeFences(doc.mdx.trim()))}\n`,
    frontmatter,
  );
}

for (const locale of locales) {
  const docs = await getDocuments(locale);
  const outputRoot = path.join(contentRoot, locale, "docs");
  const expectedPaths = new Set();

  for (const doc of docs) {
    const segments = outputSegments(doc, locale);

    const outputPath =
      path.join(outputRoot, ...segments) + outputExtension(doc);
    expectedPaths.add(outputPath);
    const alternatePath = outputPath.replace(/\.mdx$/, ".md");

    const outputDirectory = path.dirname(outputPath);

    let existing = null;

    try {
      existing = await fs.readFile(outputPath, "utf-8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (existing && !existing.includes(generateMarker) && !overwrite) {
      throw new Error(
        `[payload-docs] Refusing to overwrite existing MDX: ${outputPath}\n` +
          `Set PAYLOAD_DOCS_OVERWRITE=1 only after migration cutover.`,
      );
    }

    try {
      const alternate = await fs.readFile(alternatePath, "utf-8");
      if (!alternate.includes(generateMarker) && !overwrite) {
        throw new Error(
          `[payload-docs] Refusing to remove existing MD: ${alternatePath}\n` +
            `Set PAYLOAD_DOCS_OVERWRITE=1 only after migration cutover.`,
        );
      }
      await fs.unlink(alternatePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(
      outputPath,
      createMdx({ doc, locale, outputDirectory }),
      "utf-8",
    );
    console.log(
      `[payload-docs] wrote ${path.relative(projectRoot, outputPath)}`,
    );
  }

  if (prune) {
    await pruneGeneratedDocuments(outputRoot, expectedPaths);
  }
}
