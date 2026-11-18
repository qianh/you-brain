import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import { parseProjectGroups } from "../consolidate/twin.js";
import { writeFileAtomic } from "../domain/atomic.js";

export interface SplitProjectFile {
  slug: string;
  fileName: string;
  name: string;
  repos: string[];
  headings: string[];
  content: string;
}

export interface RenderedProjectsSplit {
  indexMarkdown: string;
  files: SplitProjectFile[];
}

export interface ProjectLookupResult {
  matched: boolean;
  project: string | null;
  portrait: string;
  availableProjects: Array<{ name: string; slug: string; repos: string[] }>;
}

function slugBase(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[/\\.\0]+/gu, "-")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (cleaned === "" || cleaned === "index") return "project";
  return cleaned.slice(0, 64);
}

function uniqueSlug(name: string, used: Set<string>): string {
  const base = slugBase(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const candidate = `${base}-${suffix}`;
  used.add(candidate);
  return candidate;
}

function extractVersionLine(markdown: string): string | null {
  const second = markdown.replace(/\r\n/gu, "\n").split("\n")[1]?.trim() ?? "";
  return /v\d+\.\d+\.\d+/u.test(second) ? second : null;
}

/**
 * Derive an overview `index.md` and one `<slug>.md` file per project group from `projects.md`.
 */
export function renderProjectsSplit(projectsMarkdown: string): RenderedProjectsSplit {
  const { groups } = parseProjectGroups(projectsMarkdown);
  const versionLine = extractVersionLine(projectsMarkdown);
  const usedSlugs = new Set<string>(["index"]);
  const files: SplitProjectFile[] = [];

  for (const group of groups) {
    const slug = uniqueSlug(group.name, usedSlugs);
    const fileName = `${slug}.md`;
    const headings = group.sections.map((section) => section.heading.replace(/^##\s+/u, "").trim());
    const headerLines = [`# 项目决定 · ${group.name}`];
    if (versionLine) headerLines.push(versionLine);
    const content = `${[headerLines.join("\n"), ...group.sections.map((section) => section.text)].join("\n\n").trimEnd()}\n`;
    files.push({
      slug,
      fileName,
      name: group.name,
      repos: [...group.repos],
      headings,
      content,
    });
  }

  const indexHeader = ["# 数字分身 · 项目索引"];
  if (versionLine) indexHeader.push(versionLine);
  const intro =
    "在具体项目工作时，按仓库目录名或项目名只读对应文件（或调 MCP `get_portrait` 传 `variant=\"projects\"` 与 `project=\"<仓库或项目名>\"`），无需读取整份 `projects.md`：";
  const entries =
    files.length === 0
      ? ["（暂无已沉淀的项目决定）"]
      : files.map((file) => {
          const reposNote =
            file.repos.length > 0 ? ` · repos: \`${file.repos.join("`, `")}\`` : "";
          const subtopics = file.headings
            .map((heading) => {
              const suffix = heading.startsWith(`${file.name} · `)
                ? heading.slice(`${file.name} · `.length)
                : heading;
              return suffix;
            })
            .join(" / ");
          return `- **${file.name}**（\`~/.you-brain/portrait/projects/${file.fileName}\`${reposNote}）：${subtopics}`;
        });

  const indexMarkdown = `${[indexHeader.join("\n"), intro, entries.join("\n")].join("\n\n").trimEnd()}\n`;
  return { indexMarkdown, files };
}

/**
 * Write `~/.you-brain/portrait/projects/index.md` and `<slug>.md` files, removing stale `.md` files.
 */
export async function syncSplitProjectFiles(
  portraitDir: string,
  projectsMarkdown: string,
): Promise<{ dir: string; indexPath: string; written: number; removed: number }> {
  const dir = join(portraitDir, "projects");
  await mkdir(dir, { recursive: true });
  const { indexMarkdown, files } = renderProjectsSplit(projectsMarkdown);

  const targets = new Map<string, string>([["index.md", indexMarkdown]]);
  for (const file of files) {
    targets.set(file.fileName, file.content);
  }

  let written = 0;
  for (const [fileName, text] of targets) {
    const targetPath = join(dir, fileName);
    const existing = await readOptionalUtf8(targetPath);
    if (existing === text) continue;
    await writeFileAtomic(targetPath, text);
    written += 1;
  }

  let removed = 0;
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (!entry.endsWith(".md") || targets.has(entry)) continue;
    await rm(join(dir, entry), { force: true });
    removed += 1;
  }

  return { dir, indexPath: join(dir, "index.md"), written, removed };
}

/**
 * Look up a single project's decisions by repo directory name, project prefix, or path.
 * When `query` is omitted, returns the compact `index.md` overview instead of the full master file.
 */
export function lookupProjectPortrait(
  projectsMarkdown: string,
  query?: string,
): ProjectLookupResult {
  const { indexMarkdown, files } = renderProjectsSplit(projectsMarkdown);
  const availableProjects = files.map((file) => ({
    name: file.name,
    slug: file.slug,
    repos: file.repos,
  }));

  const raw = query?.trim() ?? "";
  if (raw === "") {
    return {
      matched: true,
      project: null,
      portrait: indexMarkdown,
      availableProjects,
    };
  }

  const normalized = raw.replace(/[/\\]+$/gu, "").toLowerCase();
  const base = basename(normalized.replaceAll("\\", "/")).toLowerCase();
  const tokens = [...new Set([normalized, base].filter((token) => token !== ""))];

  // 1. Exact repository directory match
  const repoMatches = files.filter((file) =>
    file.repos.some((repo) => tokens.includes(repo.toLowerCase())),
  );
  if (repoMatches.length > 0) {
    return buildHitResult(repoMatches, availableProjects);
  }

  // 2. Exact project name or slug match
  const exactMatches = files.filter((file) => {
    const lowerName = file.name.toLowerCase();
    return tokens.includes(lowerName) || tokens.includes(file.slug);
  });
  if (exactMatches.length > 0) {
    return buildHitResult(exactMatches, availableProjects);
  }

  // 3. Substring match on project name or repo name (for >= 2 char queries)
  if (base.length >= 2) {
    const partialMatches = files.filter((file) => {
      const lowerName = file.name.toLowerCase();
      if (lowerName.includes(base) || (lowerName.length >= 2 && base.includes(lowerName))) {
        return true;
      }
      return file.repos.some((repo) => {
        const lowerRepo = repo.toLowerCase();
        return lowerRepo.includes(base) || (lowerRepo.length >= 2 && base.includes(lowerRepo));
      });
    });
    if (partialMatches.length > 0) {
      return buildHitResult(partialMatches, availableProjects);
    }
  }

  return {
    matched: false,
    project: null,
    portrait: indexMarkdown,
    availableProjects,
  };
}

function buildHitResult(
  hits: readonly SplitProjectFile[],
  availableProjects: Array<{ name: string; slug: string; repos: string[] }>,
): ProjectLookupResult {
  return {
    matched: true,
    project: hits.map((item) => item.name).join("、"),
    portrait: `${hits.map((item) => item.content.trimEnd()).join("\n\n")}\n`,
    availableProjects,
  };
}

async function readOptionalUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
