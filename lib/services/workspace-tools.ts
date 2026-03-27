import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import type { WorkspaceCommand, WorkspaceManifest } from "@/lib/types";

const MAX_LISTED_FILES = 200;
const MAX_SEARCH_MATCHES = 60;

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function execFileAsync(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWithinRoot(rootPath: string, inputPath = ".") {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(resolvedRoot, inputPath);

  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Requested path escapes the workspace root.");
  }

  return resolvedTarget;
}

async function discoverWorkspaceCommands(rootPath: string) {
  const commands: WorkspaceCommand[] = [];

  if (await pathExists(path.join(rootPath, ".git"))) {
    commands.push({
      id: "git_status",
      label: "Git status",
      command: ["git", "-C", rootPath, "status", "--short", "--branch"],
    });
    commands.push({
      id: "git_diff_stat",
      label: "Git diff stat",
      command: ["git", "-C", rootPath, "diff", "--stat"],
    });
  }

  const packageJsonPath = path.join(rootPath, "package.json");
  if (await pathExists(packageJsonPath)) {
    const rawPackageJson = await fs.readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(rawPackageJson) as {
      scripts?: Record<string, string>;
    };

    for (const scriptName of ["build", "lint", "test", "typecheck"]) {
      if (parsed.scripts?.[scriptName]) {
        commands.push({
          id: `npm_${scriptName}`,
          label: `npm run ${scriptName}`,
          command: [npmCommand(), "run", scriptName],
        });
      }
    }
  }

  return commands;
}

async function collectFiles(
  rootPath: string,
  startPath: string,
  collected: string[],
): Promise<void> {
  if (collected.length >= MAX_LISTED_FILES) {
    return;
  }

  const entries = await fs.readdir(startPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
      continue;
    }

    const absolutePath = path.join(startPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      await collectFiles(rootPath, absolutePath, collected);
      continue;
    }

    collected.push(relativePath);
    if (collected.length >= MAX_LISTED_FILES) {
      return;
    }
  }
}

export async function validateWorkspacePath(
  workspacePath: string,
): Promise<WorkspaceManifest> {
  const normalized = path.resolve(workspacePath);
  const stats = await fs.stat(normalized);
  if (!stats.isDirectory()) {
    throw new Error("Workspace path must be a directory.");
  }

  const commands = await discoverWorkspaceCommands(normalized);

  return {
    rootPath: normalized,
    commands,
  };
}

export async function listFiles(rootPath: string, relativePath?: string) {
  const target = resolveWithinRoot(rootPath, relativePath);
  const collected: string[] = [];
  await collectFiles(rootPath, target, collected);
  return collected;
}

export async function readFileFromWorkspace(
  rootPath: string,
  relativePath: string,
  startLine = 1,
  endLine = 200,
) {
  const target = resolveWithinRoot(rootPath, relativePath);
  const raw = await fs.readFile(target, "utf8");
  const lines = raw.split(/\r?\n/);
  const slice = lines.slice(Math.max(0, startLine - 1), endLine);

  return {
    path: path.relative(rootPath, target).replace(/\\/g, "/"),
    startLine,
    endLine,
    content: slice.join("\n"),
  };
}

export async function searchFilesInWorkspace(
  rootPath: string,
  query: string,
  relativePath?: string,
) {
  const target = resolveWithinRoot(rootPath, relativePath);
  const allFiles = await listFiles(rootPath, path.relative(rootPath, target));
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];

  for (const relativeFilePath of allFiles) {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      break;
    }

    const absolute = resolveWithinRoot(rootPath, relativeFilePath);
    const stats = await fs.stat(absolute);
    if (stats.size > 1_000_000) {
      continue;
    }

    const raw = await fs.readFile(absolute, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }

    const lines = raw.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return;
      }
      if (line.toLowerCase().includes(query.toLowerCase())) {
        matches.push({
          path: relativeFilePath,
          line: index + 1,
          excerpt: line.trim(),
        });
      }
    });
  }

  return matches;
}

export async function runWorkspaceCheck(
  manifest: WorkspaceManifest,
  commandId: string,
) {
  const command = manifest.commands.find((entry) => entry.id === commandId);
  if (!command) {
    throw new Error(`Unsupported workspace check "${commandId}".`);
  }

  const [binary, ...args] = command.command;
  const result = await execFileAsync(binary, args, manifest.rootPath);

  return {
    commandId,
    label: command.label,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
