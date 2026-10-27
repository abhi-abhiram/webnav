import { z } from "zod";

type Schema = Record<string, unknown>;
export type Contracts = { argsSchema?: Schema; resultSchema?: Schema; effect?: "read" | "write"; cacheTtlMs?: number };
const annotations = ["title", "description", "$comment", "examples", "default"];
const common = ["type", "enum", "const", ...annotations];
const keywords: Record<string, string[]> = {
  object: ["properties", "required", "additionalProperties"], array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength", "pattern"], number: ["minimum", "maximum"], integer: ["minimum", "maximum"], boolean: [], null: [],
};

// Deliberately small JSON Schema subset. Reject unsupported keywords rather than silently
// weakening success contracts. No coercion/defaults, remote refs, or experimental converter.
function compile(input: unknown, depth = 0): z.ZodType {
  if (depth > 40) throw new Error("contract schema nesting exceeds 40");
  if (typeof input === "boolean") return input ? z.unknown() : z.never();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("contract schema must be an object");
  const s = input as any;
  if (s.type !== undefined && (typeof s.type !== "string" || !Object.hasOwn(keywords, s.type))) throw new Error(`unsupported contract type: ${s.type}`);
  for (const key of Object.keys(s)) if (![...common, ...(keywords[s.type] ?? [])].includes(key)) throw new Error(`unsupported contract keyword: ${key} (declare type explicitly)`);
  let result: z.ZodType = z.unknown();
  const bound = (key: string, integer = false) => {
    const value = s[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || (integer && (!Number.isInteger(value) || value < 0)))) throw new Error(`invalid contract ${key}`);
    return value as number | undefined;
  };
  switch (s.type) {
    case "object": {
      if (s.properties !== undefined && (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties))) throw new Error("invalid contract properties");
      const properties = s.properties ?? {};
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((k: unknown) => typeof k !== "string" || !Object.hasOwn(properties, k)))) throw new Error("contract required keys must be declared in properties");
      const required = new Set<string>(s.required ?? []);
      const shape = Object.fromEntries(Object.entries(properties).map(([key, schema]) => {
        const field = compile(schema, depth + 1);
        return [key, required.has(key) ? field.refine(v => v !== undefined, "required") : field.optional()];
      }));
      const object = z.object(shape);
      result = s.additionalProperties === false ? object.strict() : s.additionalProperties === undefined || s.additionalProperties === true ? object.passthrough() : object.catchall(compile(s.additionalProperties, depth + 1));
      break;
    }
    case "array": {
      let array = z.array(compile(s.items ?? true, depth + 1));
      if (bound("minItems", true) !== undefined) array = array.min(s.minItems);
      if (bound("maxItems", true) !== undefined) array = array.max(s.maxItems);
      result = array; break;
    }
    case "string": {
      let string = z.string();
      if (bound("minLength", true) !== undefined) string = string.min(s.minLength);
      if (bound("maxLength", true) !== undefined) string = string.max(s.maxLength);
      if (s.pattern !== undefined) { if (typeof s.pattern !== "string") throw new Error("invalid contract pattern"); string = string.regex(new RegExp(s.pattern)); }
      result = string; break;
    }
    case "number": case "integer": {
      let number = s.type === "integer" ? z.number().int() : z.number();
      if (bound("minimum") !== undefined) number = number.min(s.minimum);
      if (bound("maximum") !== undefined) number = number.max(s.maximum);
      result = number; break;
    }
    case "boolean": result = z.boolean(); break;
    case "null": result = z.null(); break;
  }
  if (s.enum !== undefined) {
    if (!Array.isArray(s.enum) || !s.enum.length) throw new Error("contract enum must be a nonempty array");
    result = result.refine(value => s.enum.some((entry: unknown) => canonical(entry) === canonical(value)), "not in enum");
  }
  if (Object.hasOwn(s, "const")) result = result.refine(value => canonical(value) === canonical(s.const), "does not match const");
  return result;
}

export function validateContracts(meta: Contracts & { safe?: boolean }): void {
  if (meta.safe !== undefined && typeof meta.safe !== "boolean") throw new Error("meta.safe must be a boolean");
  if (meta.effect !== undefined && !["read", "write"].includes(meta.effect)) throw new Error("meta.effect must be read or write");
  if (meta.safe && meta.effect === "write") throw new Error("write functions cannot be meta.safe");
  if (meta.cacheTtlMs !== undefined && (meta.effect !== "read" || !Number.isInteger(meta.cacheTtlMs) || meta.cacheTtlMs < 1 || meta.cacheTtlMs > 3_600_000)) throw new Error("meta.cacheTtlMs requires effect: read and must be 1–3600000");
  for (const schema of [meta.argsSchema, meta.resultSchema]) if (schema !== undefined) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("contract schemas must be JSON Schema objects");
    compile(schema);
  }
}
export function assertSchema(schema: Schema | undefined, value: unknown, label: string): void {
  if (!schema) return;
  const result = compile(schema).safeParse(value);
  if (!result.success) throw new Error(`${label}: ${result.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "root"}: ${i.message}`).join("; ").slice(0, 1800)}`);
}
// Stable keys: object insertion order is irrelevant; array order is not.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
}
