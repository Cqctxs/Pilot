/**
 * Two capability ids with the same shape are two standards for one thing.
 *
 * The usual cause is a value baked into a name — a hotels capability for a
 * single city, when the city belongs in the query. Nothing can merge them
 * safely (that would rewrite the contract every existing Pilot compiled
 * against), so the job is to notice and say so at declare time.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapabilities } from "../../src/cli/capabilities.js";
import { parseArgs } from "../../src/cli/args.js";
import { loadEnv, type PilotEnv } from "../../src/shared/env.js";

let root: string;
let env: PilotEnv;
let out: string[];
let write: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "pilot-overlap-"));
  env = { ...loadEnv(), capabilitiesDir: path.join(root, "capabilities") };
  out = [];
  write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  write.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const add = (id: string, fields: string) =>
  runCapabilities(env, parseArgs(["add", id, "--fields", fields]));

describe("overlap detection", () => {
  it("flags a new capability whose fields already exist in another", async () => {
    await add("hotels.search@1", "hotelName:string!=Name,hotelUrl:url!=Link,pricePerNight:number=Rate,currency:string=ISO code");
    out.length = 0;
    await add("hotels.boston@1", "hotelName:string!=Name,hotelUrl:url!=Link,pricePerNight:number=Rate");

    const text = out.join("");
    expect(text).toContain("Every field of hotels.boston@1 already exists in hotels.search@1");
    // A warning, not a refusal — a genuine near-twin is a normal declaration.
    expect(text).toContain("Declared hotels.boston@1");
  });

  it("says nothing about capabilities that merely share a field name", async () => {
    await add("hotels.search@1", "hotelName:string!=Name,hotelUrl:url!=Link,pricePerNight:number=Rate,currency:string=ISO");
    out.length = 0;
    await add("flights.search@1", "carrier:string!=Airline,flightUrl:url!=Link,currency:string=ISO");

    expect(out.join("")).not.toContain("already exists in");
  });

  it("still refuses to redefine the same id", async () => {
    await add("hotels.search@1", "hotelName:string!=Name,hotelUrl:url!=Link");
    await expect(add("hotels.search@1", "hotelName:string!=Name")).rejects.toThrow(/already exists/);
  });
});
