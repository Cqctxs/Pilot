/**
 * Reading a script to see which query keys it uses.
 *
 * Reported as a false accusation: the first version matched `query.foo` only,
 * so `const { origin } = query` was announced as "ignores its query" — on the
 * tool whose whole job is telling you whether to recompile. Being wrong in that
 * direction sends someone to recompile a working Pilot, and discredits the
 * finding when a Pilot really is hardcoded.
 */
import { describe, expect, it } from "vitest";
import { queryReads } from "../../src/pilots/reads.js";

describe("queryReads", () => {
  it("reads plain member access", () => {
    const result = queryReads(`export async function search(page, query) {
      return fetch(\`/x?q=\${query.keywords}&l=\${query.location}\`);
    }`);
    expect(result.keys).toEqual(["keywords", "location"]);
    expect(result.confidence).toBe("exact");
  });

  it("reads destructuring, which used to read as ignoring the query", () => {
    const result = queryReads(`export async function search(page, query) {
      const { origin, destination } = query;
      return fetch(\`/f?from=\${origin}&to=\${destination}\`);
    }`);
    expect(result.keys).toEqual(["destination", "origin"]);
    expect(result.confidence).toBe("exact");
  });

  it("reads destructuring in the signature", () => {
    const result = queryReads(`export async function search(page, { origin, departureDate }) {
      return fetch(\`/f?from=\${origin}&on=\${departureDate}\`);
    }`);
    expect(result.keys).toEqual(["departureDate", "origin"]);
  });

  it("follows an alias", () => {
    const result = queryReads(`export async function search(page, query) {
      const q = query;
      return fetch(\`/x?q=\${q.keywords}\`);
    }`);
    expect(result.keys).toEqual(["keywords"]);
  });

  it("reads bracket access and renamed destructuring", () => {
    const result = queryReads(`export async function search(page, query) {
      const { location: where = "" } = query;
      return fetch(\`/x?q=\${query["keywords"]}&l=\${where}\`);
    }`);
    expect(result.keys).toEqual(["keywords", "location"]);
  });

  /**
   * The honest middle. Something is done with the query and this cannot say
   * what — which must not be reported as ignoring it.
   */
  it("says it is unsure rather than accusing, when the query is used opaquely", () => {
    const result = queryReads(`export async function search(page, query) {
      const params = new URLSearchParams({ ...query });
      return fetch(\`/x?\${params}\`);
    }`);
    expect(result.confidence).toBe("uncertain");
    expect(result.keys).toEqual([]);
    expect(result.note).toMatch(/could not tell/);
  });

  it("accuses only when the script never mentions the query at all", () => {
    const result = queryReads(`export async function search(page) {
      return fetch("/x?q=software+intern&l=Toronto");
    }`);
    expect(result.confidence).toBe("none");
    expect(result.note).toMatch(/never mentions/);
  });
});
