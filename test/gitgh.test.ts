import { test, expect, describe } from "bun:test";
import { branchFor } from "../src/gitgh.ts";

describe("branchFor", () => {
  test("truncation never leaves a trailing hyphen (#457 regression)", () => {
    // Title slugifies to 50+ chars; slice(0,40) used to land on "...via-".
    const got = branchFor(
      457,
      "I2 — Deepen SafariWebExtensionHandler via the Shared Kernel",
    );
    expect(got).toBe("loop/457-i2-deepen-safariwebextensionhandler-via");
    expect(got.endsWith("-")).toBe(false);
  });

  test("lowercases and hyphenates a short title", () => {
    expect(branchFor(12, "Dedup Word Tap Dispatch")).toBe(
      "loop/12-dedup-word-tap-dispatch",
    );
  });

  test("strips leading/trailing punctuation", () => {
    expect(branchFor(1, "  --Hello, World!!  ")).toBe("loop/1-hello-world");
  });

  test("falls back to 'ticket' when the slug is empty", () => {
    expect(branchFor(1, "### ???")).toBe("loop/1-ticket");
  });

  test("result never ends with a hyphen across long titles", () => {
    const titles = [
      "Some Very Long Title That Definitely Exceeds Forty Characters Easily",
      "A B C D E F G H H I J K L M N O P Q R S T U V W X Y Z More Words Here",
    ];
    for (const t of titles) {
      const got = branchFor(99, t);
      expect(got.endsWith("-")).toBe(false);
    }
  });
});
