// ─── Schema Describe ────────────────────────────────────────────────────────
// Zod _def types are not publicly exported, so any is unavoidable here

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeSchema(def: any): string {
  if (!def) return 'unknown';

  // Extract description if present
  const desc: string | undefined = def.description;

  const typeName: string = def.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shapeDef = def.shape;
      if (!shapeDef) return desc ?? '{}';
      const shape = typeof shapeDef === 'function' ? shapeDef() : shapeDef;
      if (!shape) return desc ?? '{}';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fields = Object.entries(shape).map(([key, field]: [string, any]) => {
        const fieldDef = field._def ?? field;
        const fieldDesc = describeSchema(fieldDef);
        return `${key}: ${fieldDesc}`;
      });
      const objStr = fields.length > 0 ? `{ ${fields.join(', ')} }` : '{}';
      return desc ? `${objStr} /* ${desc} */` : objStr;
    }

    case 'ZodString':
      return desc ?? 'string';

    case 'ZodNumber':
      return desc ?? 'number';

    case 'ZodBoolean':
      return desc ?? 'boolean';

    case 'ZodArray': {
      const itemType = def.type?._def ? describeSchema(def.type._def) : 'unknown';
      return desc ? `Array<${itemType}> /* ${desc} */` : `Array<${itemType}>`;
    }

    case 'ZodEnum': {
      const values: string[] = def.values ?? [];
      return desc
        ? `${values.map((v) => `"${v}"`).join(' | ')} /* ${desc} */`
        : values.map((v) => `"${v}"`).join(' | ');
    }

    case 'ZodOptional': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `${inner} | undefined`;
    }

    case 'ZodNullable': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `${inner} | null`;
    }

    case 'ZodDefault': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      const defaultVal = def.defaultValue();
      return `${inner} (default: ${JSON.stringify(defaultVal)})`;
    }

    case 'ZodLiteral': {
      return JSON.stringify(def.value);
    }

    case 'ZodAny':
      return 'any';

    case 'ZodUnknown':
      return 'unknown';

    case 'ZodVoid':
    case 'ZodUndefined':
      return 'undefined';

    case 'ZodNull':
      return 'null';

    case 'ZodUnion': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (def.options ?? []).map((opt: any) => describeSchema(opt._def));
      return options.join(' | ');
    }

    case 'ZodEffects': {
      const inner = def.schema?._def ? describeSchema(def.schema._def) : 'unknown';
      return desc ? `${inner} /* ${desc} */` : `${inner} /* with effects */`;
    }

    case 'ZodBranded': {
      const inner = def.type?._def ? describeSchema(def.type._def) : 'unknown';
      return desc ? `${inner} /* ${desc} */` : `${inner} /* branded */`;
    }

    case 'ZodNativeEnum': {
      const values: string[] = Object.values(def.values) as string[];
      return desc
        ? `${values.map((v) => `"${v}"`).join(' | ')} /* ${desc} */`
        : values.map((v) => `"${v}"`).join(' | ');
    }

    case 'ZodRecord': {
      const keyType = def.keyType?._def ? describeSchema(def.keyType._def) : 'unknown';
      const valueType = def.valueType?._def ? describeSchema(def.valueType._def) : 'unknown';
      return desc ? `Record<${keyType}, ${valueType}> /* ${desc} */` : `Record<${keyType}, ${valueType}>`;
    }

    case 'ZodTuple': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: string[] = (def.items ?? []).map((item: any) => {
        const itemDef = item._def ?? item;
        return describeSchema(itemDef);
      });
      const tupleStr = `[${items.join(', ')}]`;
      return desc ? `${tupleStr} /* ${desc} */` : tupleStr;
    }

    case 'ZodMap': {
      const keyType = def.keyType?._def ? describeSchema(def.keyType._def) : 'unknown';
      const valueType = def.valueType?._def ? describeSchema(def.valueType._def) : 'unknown';
      return desc ? `Map<${keyType}, ${valueType}> /* ${desc} */` : `Map<${keyType}, ${valueType}>`;
    }

    case 'ZodSet': {
      const itemType = def.valueType?._def ? describeSchema(def.valueType._def) : 'unknown';
      return desc ? `Set<${itemType}> /* ${desc} */` : `Set<${itemType}>`;
    }

    case 'ZodPromise': {
      const inner = def.type?._def ? describeSchema(def.type._def) : 'unknown';
      return desc ? `Promise<${inner}> /* ${desc} */` : `Promise<${inner}>`;
    }

    case 'ZodLazy': {
      try {
        const resolved = def.getter();
        const resolvedDef = resolved?._def ?? resolved;
        return describeSchema(resolvedDef);
      } catch {
        return desc ?? 'lazy';
      }
    }

    case 'ZodIntersection': {
      const left = def.left?._def ? describeSchema(def.left._def) : 'unknown';
      const right = def.right?._def ? describeSchema(def.right._def) : 'unknown';
      return `${left} & ${right}`;
    }

    case 'ZodDate':
      return desc ?? 'Date';

    case 'ZodReadonly': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `Readonly<${inner}>`;
    }

    case 'ZodPipeline': {
      const input = def.in?._def ? describeSchema(def.in._def) : 'unknown';
      return `${input} /* pipeline */`;
    }

    case 'ZodCatch': {
      const inner = def.innerType?._def ? describeSchema(def.innerType._def) : 'unknown';
      return `${inner} /* with catch */`;
    }

    default:
      return desc ?? typeName ?? 'unknown';
  }
}
