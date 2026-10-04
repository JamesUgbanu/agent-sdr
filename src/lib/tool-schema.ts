import { z } from "zod";

// Minimal Zod→JSON-schema conversion for tool catalogs (prompting + native
// function-calling). Covers the field types used by the SDR tool registry.
// Complex/nested schemas degrade to a generic object — validation always
// happens against the real Zod schema before execution.
export interface JsonField { type: string; enum?: string[]; default?: unknown; description?: string }

function fieldOf(schema: z.ZodTypeAny): JsonField {
  if (schema instanceof z.ZodDefault) {
    const inner = fieldOf((schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType);
    return { ...inner, default: (schema as unknown as { _def: { defaultValue: () => unknown } })._def.defaultValue?.() };
  }
  if (schema instanceof z.ZodOptional) {
    return fieldOf((schema as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType);
  }
  if (schema instanceof z.ZodEnum) return { type: "string", enum: (schema as unknown as { _def: { values: string[] } })._def.values };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) return { type: "array" };
  return { type: "string" };
}

export function zodToFields(schema: z.ZodTypeAny): Record<string, JsonField> {
  try {
    const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape
      ?? (schema as unknown as { _def?: { shape?: () => Record<string, z.ZodTypeAny> } })._def?.shape?.();
    if (!shape || typeof shape !== "object") return {};
    const out: Record<string, JsonField> = {};
    for (const [k, v] of Object.entries(shape)) {
      const optional = v instanceof z.ZodOptional || v instanceof z.ZodDefault;
      out[k] = { ...fieldOf(v), description: optional ? "optional" : "required" };
    }
    return out;
  } catch {
    return {};
  }
}

export function zodToJsonSchema(schema: z.ZodTypeAny): { type: "object"; properties: Record<string, JsonField>; required: string[] } {
  const fields = zodToFields(schema);
  const required = Object.entries(fields).filter(([, f]) => f.description === "required").map(([k]) => k);
  for (const f of Object.values(fields)) delete f.description;
  return { type: "object", properties: fields, required };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function stableArgs(a: unknown): string {
  try {
    return JSON.stringify(sortKeys(a) ?? null);
  } catch {
    return String(a);
  }
}
