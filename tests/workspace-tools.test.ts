import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readFileFromWorkspace,
  searchFilesInWorkspace,
  validateWorkspacePath,
} from "@/lib/services/workspace-tools";

describe("workspace tools", () => {
  let workspacePath = "";

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mac-workspace-"));
    await fs.writeFile(
      path.join(workspacePath, "package.json"),
      JSON.stringify({
        scripts: {
          lint: "eslint .",
          test: "vitest run",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspacePath, "README.md"),
      "alpha line\nbeta line\nsearch token here\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("discovers npm scripts and keeps file reads inside the workspace", async () => {
    const manifest = await validateWorkspacePath(workspacePath);
    expect(manifest.commands.some((command) => command.id === "npm_lint")).toBe(true);

    const file = await readFileFromWorkspace(workspacePath, "README.md", 1, 2);
    expect(file.content).toContain("alpha line");

    await expect(
      readFileFromWorkspace(workspacePath, "..\\..\\outside.txt"),
    ).rejects.toThrow("escapes the workspace root");
  });

  it("searches workspace files for a text query", async () => {
    const matches = await searchFilesInWorkspace(workspacePath, "search token");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("README.md");
  });
});
