import { describe, expect, test } from "bun:test";
import { registerExecutorCommands } from "../src/commands.ts";

describe("executor command registration", () => {
  test("registers human-facing lifecycle commands", () => {
    const commands: string[] = [];
    registerExecutorCommands({
      registerCommand(name: string) {
        commands.push(name);
      },
    } as any);

    expect(commands).toEqual(["executor-web", "executor-start", "executor-stop"]);
  });
});
