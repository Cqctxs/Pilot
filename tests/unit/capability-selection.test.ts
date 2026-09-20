import { describe, expect, it } from "vitest";
import { selectCapability } from "../../src/compiler/design.js";
import type { ModelClient, ModelTurn } from "../../src/compiler/model.js";
import type { CapabilityDefinition } from "../../src/capability/registry.js";
import { loadEnv } from "../../src/shared/env.js";

const books: CapabilityDefinition = {
  capabilityFormatVersion: 1,
  id: "books.list@1",
  version: "1.0.0",
  schema: {
    name: "books.list@1",
    fields: [
      { name: "title", type: "string", required: true, description: "Book title" },
      { name: "url", type: "url", required: true, description: "Book details URL" },
      { name: "price", type: "number", required: false, description: "Displayed price" },
    ],
  },
  coreFields: ["title", "url", "price"],
};

function model(...turns: ModelTurn[]): ModelClient {
  let index = 0;
  return {
    model: "fake-selector",
    async turn() {
      return turns[index++]!;
    },
  };
}

function selection(args: Record<string, unknown>): ModelTurn {
  return {
    raw: [],
    text: null,
    toolCalls: [{ id: "choice", name: "select_capability", args }],
  };
}

const evidence = {
  url: "https://books.example/",
  text: "Books: A Light in the Attic — £51.77 — In stock",
};

describe("automatic capability selection", () => {
  it("reuses an existing shared interface for another site of the same kind", async () => {
    const selected = await selectCapability({
      evidence,
      candidates: [books],
      env: loadEnv(),
      client: model(
        selection({
          action: "use_existing",
          capabilityId: "books.list@1",
          fields: [],
          rationale: "This is another book catalogue.",
        }),
      ),
    });

    expect(selected.action).toBe("use_existing");
    if (selected.action === "use_existing") expect(selected.definition).toEqual(books);
  });

  it("creates a generic shared interface when the catalog has no match", async () => {
    const selected = await selectCapability({
      evidence,
      candidates: [],
      env: loadEnv(),
      client: model(
        selection({
          action: "create_new",
          capabilityId: "books.list@1",
          fields: books.schema.fields,
          rationale: "No book-listing capability exists yet.",
        }),
      ),
    });

    expect(selected).toMatchObject({
      action: "create_new",
      id: "books.list@1",
      fields: books.schema.fields,
    });
  });

  it("rejects invented ids for the existing-capability branch and lets the model retry", async () => {
    const selected = await selectCapability({
      evidence,
      candidates: [books],
      env: loadEnv(),
      client: model(
        selection({
          action: "use_existing",
          capabilityId: "books.catalog@1",
          fields: [],
          rationale: "Invented rather than selected.",
        }),
        selection({
          action: "use_existing",
          capabilityId: "books.list@1",
          fields: [],
          rationale: "Exact catalog candidate.",
        }),
      ),
    });

    expect(selected.action).toBe("use_existing");
    if (selected.action === "use_existing") expect(selected.definition.id).toBe("books.list@1");
  });
});
