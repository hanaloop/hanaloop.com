import fs from "node:fs/promises";
import matter from "gray-matter";
import path from "node:path";

const exportToken = process.env.PAYLOAD_EXPORT_TOKEN;
const payloadBlogUrl = process.env.PAYLOAD_BLOG_URL;
const overwrite = process.env.PAYLOAD_BLOG_OVERWRITE === "1";
const prune = process.env.PAYLOAD_BLOG_PRUNE !== "0";

if (!payloadBlogUrl) {
  console.log("[payload-blog] PAYLOAD_BLOG_URL is not set; skipping sync.");
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
    value.trim() !== value ||
    value === "." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`[payload-blog] Invalid path segment: ${String(value)}`);
  }

  return value;
}

function outputSegments(post, locale) {
  if (typeof post.sourcePath === "string" && post.sourcePath) {
    const prefix = `${locale}/blog/`;

    if (!post.sourcePath.startsWith(prefix)) {
      throw new Error(
        `[payload-blog] sourcePath locale mismatch:
          ${post.sourcePath}`,
      );
    }

    return post.sourcePath
      .slice(prefix.length)
      .replace(/\.mdx?$/i, "")
      .split("/")
      .map(safeSegment);
  }

  const publishedDate = post.publishedAt
    ? new Date(post.publishedAt)
    : new Date();

  const year = String(publishedDate.getUTCFullYear());

  return [year, safeSegment(post.slug)];
}

function toImportPath(fromDirectory, targetWithoutExtension) {
  const relative = path
    .relative(fromDirectory, targetWithoutExtension)
    .replaceAll("\\", "/");

  return relative.startsWith(".") ? relative : `./${relative}`;
}

function restoreEscapedCodeFences(mdx) {
  const escapedFence = String.fromCharCode(92, 96, 92, 96, 92, 96);
  const fence = "```";

  return String(mdx)
    .split("\n")
    .map((line) =>
      line.startsWith(escapedFence)
        ? `${fence}${line.slice(escapedFence.length)}`
        : line,
    )
    .join("\n");
}

function splitTableRow(line) {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toTableCellHtml(value) {
  return escapeHtml(value)
    // MDX's GFM parser treats a bare `~` as strikethrough syntax even inside
    // an HTML table cell. Keep the rendered character while preventing it
    // from crossing a subsequent HTML tag during parsing.
    .replaceAll("~", "&#126;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/&lt;br\s*\/?&gt;/gi, "<br />");
}

// Fumadocs' deployed blog content historically uses raw HTML tables. Payload's
// Lexical Markdown converter emits GFM tables, so normalize the generated
// artifact to the existing rendering format without changing authored data.
function serializeTablesAsHtml(mdx) {
  const lines = mdx.split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isTableDivider(lines[index + 1] ?? "")) {
      output.push(lines[index]);
      continue;
    }

    const header = splitTableRow(lines[index]);
    index += 2;
    const rows = [];

    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      rows.push(splitTableRow(lines[index]));
      index += 1;
    }

    output.push(
      "<table>",
      "  <thead>",
      `    <tr>${header.map((cell) => `<th>${toTableCellHtml(cell)}</th>`).join("")}</tr>`,
      "  </thead>",
      "  <tbody>",
      ...rows.map(
        (row) =>
          `    <tr>${row.map((cell) => `<td>${toTableCellHtml(cell)}</td>`).join("")}</tr>`,
      ),
      "  </tbody>",
      "</table>",
    );

    index -= 1;
  }

  return output.join("\n");
}

async function getPosts(locale) {
  const url = new URL(payloadBlogUrl);
  url.searchParams.set("locale", locale);

  const response = await fetch(url, {
    headers: exportToken
      ? { Authorization: `Bearer ${exportToken}` }
      : undefined,
  });

  if (!response.ok) {
    throw new Error(
      `[payload-blog] ${locale} export failed: ${response.status}
        ${response.statusText}`,
    );
  }

  const payload = await response.json();

  if (!Array.isArray(payload.posts)) {
    throw new Error(`[payload-blog] Invalid response for locale "${locale}".`);
  }

  return payload.posts;
}

function createMdx({ post, locale, outputDirectory }) {
  const imports = [];

  if (/<CaptionedImage\b/.test(post.mdx)) {
    const componentPath = path.join(
      contentRoot,
      locale,
      "src",
      "components",
      "theme",
      "CaptionedImage",
    );

    imports.push(
      `import CaptionedImage from ${JSON.stringify(
        toImportPath(outputDirectory, componentPath),
      )};`,
    );
  }

  if (/<Callout\b/.test(post.mdx)) {
    imports.push(`import { Callout } from 'fumadocs-ui/components/callout';`);
  }

  const frontmatter = {
    ...(post.sourceMetadata && typeof post.sourceMetadata === "object"
      ? post.sourceMetadata
      : {}),
    title: post.title,
    ...(post.description ? { description: post.description } : {}),
    ...(post.subtitle ? { subtitle: post.subtitle } : {}),
    ...(post.summary ? { summary: post.summary } : {}),
    ...(post.authors?.length ? { authors: post.authors } : {}),
    ...(post.tags?.length ? { tags: post.tags } : {}),
    ...(post.publishedAt ? { date: post.publishedAt } : {}),
    payloadGenerated: true,
  };

  return matter.stringify(
    `${imports.join("\n")}\n\n${serializeTablesAsHtml(restoreEscapedCodeFences(post.mdx.trim()))}\n`,
    frontmatter,
  );
}

async function pruneGeneratedPosts(directory, expectedPaths) {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await pruneGeneratedPosts(filePath, expectedPaths);
      continue;
    }

    if (!/\.mdx?$/.test(entry.name) || expectedPaths.has(filePath)) {
      continue;
    }

    const content = await fs.readFile(filePath, "utf8");

    if (!content.includes(generateMarker)) {
      continue;
    }

    await fs.unlink(filePath);

    console.log(
      `[payload-blog] removed ${path.relative(projectRoot, filePath)}`,
    );
  }
}

for (const locale of locales) {
  const posts = await getPosts(locale);
  const outputRoot = path.join(contentRoot, locale, "blog");
  const expectedPaths = new Set();

  for (const post of posts) {
    const outputPath = `${path.join(
      outputRoot,
      ...outputSegments(post, locale),
    )}.mdx`;

    const outputDirectory = path.dirname(outputPath);
    const alternatePath = outputPath.replace(/\.mdx$/, ".md");

    expectedPaths.add(outputPath);

    try {
      const existing = await fs.readFile(outputPath, "utf8");

      if (!existing.includes(generateMarker) && !overwrite) {
        throw new Error(
          `[payload-blog] Refusing to overwrite existing MDX:
            ${outputPath}\n` +
            "Set PAYLOAD_BLOG_OVERWRITE=1 only after migration cutover.",
        );
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const alternate = await fs.readFile(alternatePath, "utf8");

      if (!alternate.includes(generateMarker) && !overwrite) {
        throw new Error(
          `[payload-blog] Refusing to remove existing MD:
            ${alternatePath}\n` +
            "Set PAYLOAD_BLOG_OVERWRITE=1 only after migration cutover.",
        );
      }

      await fs.unlink(alternatePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.mkdir(outputDirectory, { recursive: true });

    await fs.writeFile(
      outputPath,
      createMdx({ post, locale, outputDirectory }),
      "utf8",
    );

    console.log(
      `[payload-blog] wrote ${path.relative(projectRoot, outputPath)}`,
    );
  }

  if (prune) {
    await pruneGeneratedPosts(outputRoot, expectedPaths);
  }
}
