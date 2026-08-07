import { defineConfig, defineDocs, defineCollections } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

const contentEnabled = process.env.HANALOOP_ENABLE_CONTENT !== '0';
const disabledDocsDir = 'content/_disabled/docs';
const disabledBlogDir = 'content/_disabled/blog';

const docsPageSchema = pageSchema.extend({
  tags: z.array(z.string()).optional(),
});

const docsOptions = {
  docs: {
    schema: docsPageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
    files: ['**/meta.json'] as string[],
  },
};

const blogSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  subtitle: z.string().optional(),
  summary: z.string().optional(),
  image: z.string().optional(),
  date: z.union([z.string(), z.date()]).optional(),
  publishedAt: z.string().optional(),
  authors: z.union([z.string(), z.array(z.string())]).optional(),
  tags: z.array(z.string()).optional(),
});

function createBlogCollection(dir: string) {
  return defineCollections({
    type: 'doc',
    dir,
    schema: blogSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  });
}

export const docsKo = defineDocs({
  dir: contentEnabled ? 'content/ko/docs' : disabledDocsDir,
  ...docsOptions,
});

export const docsEn = defineDocs({
  dir: contentEnabled ? 'content/en/docs' : disabledDocsDir,
  ...docsOptions,
});

export const docsEs = defineDocs({
  dir: contentEnabled ? 'content/es/docs' : disabledDocsDir,
  ...docsOptions,
});

export const blogKo = createBlogCollection(contentEnabled ? 'content/ko/blog' : disabledBlogDir);
export const blogEn = createBlogCollection(contentEnabled ? 'content/en/blog' : disabledBlogDir);
export const blogEs = createBlogCollection(contentEnabled ? 'content/es/blog' : disabledBlogDir);

export default defineConfig({});
