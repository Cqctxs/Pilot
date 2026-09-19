/**
 * The tools the model is given. This list is the entire surface it can act
 * through — it cannot read files, call arbitrary hosts, or run code outside the
 * page it is looking at.
 */
export const EXPLORER_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "goto",
      description:
        "Navigate to a URL and return the status, final URL, page title and visible text. Start here.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL to load" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "find",
      description:
        "Test a CSS selector against the current page. Returns how many elements matched and the text, outerHTML and href of the first few. Use this to verify a row selector before relying on it.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          limit: { type: "integer", description: "How many matches to show (1-5)" },
        },
        required: ["selector"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fill",
      description: "Type a value into an input on the current page.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "click",
      description:
        "Click an element and wait for the page to settle. Returns the resulting URL — useful for discovering the search URL pattern.",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "evaluate",
      description:
        "Run a JavaScript expression or arrow function in the page and return its JSON result. Use this to test a full extraction before submitting it, e.g. \"() => [...document.querySelectorAll('.card')].map(el => ({title: el.querySelector('h3')?.innerText}))\".",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "An expression or arrow function" } },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "requests",
      description:
        "List JSON responses the page has fetched, with sample bodies. If one carries the records, prefer writing a script that calls it directly instead of scraping the DOM.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "submit_script",
      description:
        "Submit the finished extraction script. Only call this once you have tested the extraction with `evaluate` or `find` and seen real records.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "A complete ES module exporting `export async function search(page, query)` returning an array of record objects.",
          },
          needsBrowser: {
            type: "boolean",
            description:
              "false only if the script never touches `page` and works purely from fetch/HTTP calls.",
          },
          discoveredFields: {
            type: "array",
            items: { type: "string" },
            description:
              "Useful fields this site exposes that are NOT in the target schema, e.g. salary, seniority. Recorded, not extracted.",
          },
          notes: {
            type: "string",
            description: "One or two sentences on how the site works and what the script does.",
          },
        },
        required: ["code", "needsBrowser"],
        additionalProperties: false,
      },
    },
  },
];

export type ToolName =
  | "goto"
  | "find"
  | "fill"
  | "click"
  | "evaluate"
  | "requests"
  | "submit_script";
