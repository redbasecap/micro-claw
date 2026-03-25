import { describe, expect, test } from "vitest";
import { parseBaseModelFromModelfileSource } from "../src/setup/ollama-setup.js";

describe("parseBaseModelFromModelfileSource", () => {
  test("extracts the FROM model from a modelfile", () => {
    const source = [
      "FROM qwen2.5-coder:14b",
      "",
      "PARAMETER temperature 0.1"
    ].join("\n");

    expect(parseBaseModelFromModelfileSource(source)).toBe("qwen2.5-coder:14b");
  });
});
