import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDefaultExecutorSettings,
  resolveExecutorSettings,
  updateExecutorSettings,
} from "../src/settings.ts";

const originalHome = process.env.HOME;
const cleanup: string[] = [];

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const createWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "pi-executor-settings-"));
  cleanup.push(dir);
  return dir;
};

describe("executor settings", () => {
  test("returns default settings when no files exist", async () => {
    const cwd = await createWorkspace();
    const home = await createWorkspace();
    process.env.HOME = home;

    expect(await resolveExecutorSettings(cwd)).toEqual(getDefaultExecutorSettings());
  });

  test("merges global and project settings", async () => {
    const cwd = await createWorkspace();
    const home = await createWorkspace();
    process.env.HOME = home;

    await updateExecutorSettings(cwd, "global", {
      mode: "remote",
      remoteUrl: "https://executor.example.com/",
      showFooterStatus: false,
    });
    await updateExecutorSettings(cwd, "project", {
      autoStart: false,
      showFooterStatus: true,
    });

    expect(await resolveExecutorSettings(cwd)).toEqual({
      mode: "remote",
      autoStart: false,
      remoteUrl: "https://executor.example.com",
      showFooterStatus: true,
      stopLocalOnShutdown: true,
    });
  });

  test("writes namespaced settings without clobbering sibling keys", async () => {
    const cwd = await createWorkspace();
    const home = await createWorkspace();
    process.env.HOME = home;

    const settings = await updateExecutorSettings(cwd, "project", {
      mode: "remote",
      remoteUrl: "https://remote.example.com",
    });

    expect(settings.mode).toBe("remote");
    expect(settings.remoteUrl).toBe("https://remote.example.com");
    expect(settings.autoStart).toBe(true);
  });
});
