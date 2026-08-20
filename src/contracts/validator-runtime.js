import {canonicalJson} from "./acp.js";
import {validateContractSchemaCatalog} from "./schema-catalog.js";

function schemaError(row,message) {
  throw new TypeError(`Invalid contract schema ${row.schemaId}: ${message}`);
}

function eventFor(phase,state,row) {
  const event={phase,state};
  if (row?.schemaId!==undefined) {
    event.schema_id=row.schemaId;
    event.schema_uri=row.uri;
  }
  return Object.freeze(event);
}

function observed(phase,observe,row,operation) {
  observe(eventFor(phase,"start",row));
  try {
    return operation();
  } finally {
    observe(eventFor(phase,"end",row));
  }
}

function verifySchemaIdentity(schema,row) {
  if (schema===null || typeof schema!=="object" || Array.isArray(schema) ||
      Object.getPrototypeOf(schema)!==Object.prototype) {
    schemaError(row,"schema root must be a plain JSON record");
  }
  const descriptor=Object.getOwnPropertyDescriptor(schema,"$id");
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    schemaError(row,"schema $id is missing or unsafe");
  }
  if (descriptor.value!==row.uri) {
    schemaError(row,`schema $id does not match ${row.schemaId}`);
  }
}

function unsafeSchemaJson(row,path,detail) {
  schemaError(row,`unsafe JSON at ${path}: ${detail}`);
}

function externalReference(ref,row,path) {
  if (typeof ref!=="string") {
    schemaError(row,`$ref at ${path} must be a string`);
  }
  if (ref.startsWith("#")) return undefined;
  const fragmentIndex=ref.indexOf("#");
  const lookupUri=fragmentIndex===-1 ? ref : ref.slice(0,fragmentIndex);
  if (lookupUri.includes("?")) {
    schemaError(row,`schema reference at ${path} must not contain a query`);
  }
  const scheme=/^([A-Za-z][A-Za-z0-9+.-]*):/.exec(lookupUri)?.[1];
  if (scheme?.toLowerCase()!=="https") {
    schemaError(row,`schema reference at ${path} uses an unsupported scheme`);
  }
  return lookupUri;
}

function discoverExternalReferences(schema,row) {
  const references=[];
  const seenReferences=new Set();
  const ancestors=new Set();

  function visit(value,path) {
    if (value===null || typeof value==="string" || typeof value==="boolean") return;
    if (typeof value==="number") {
      if (!Number.isFinite(value)) unsafeSchemaJson(row,path,"number must be finite");
      return;
    }
    if (typeof value!=="object") {
      unsafeSchemaJson(row,path,`unsupported ${typeof value}`);
    }
    if (ancestors.has(value)) unsafeSchemaJson(row,path,"cyclic reference");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value)!==Array.prototype) {
          unsafeSchemaJson(row,path,"arrays must use Array.prototype");
        }
        const keys=Reflect.ownKeys(value);
        if (keys.length!==value.length+1 || !keys.includes("length")) {
          unsafeSchemaJson(row,path,"arrays must be dense and have no extra properties");
        }
        for (let index=0;index<value.length;index+=1) {
          const key=String(index);
          const descriptor=Object.getOwnPropertyDescriptor(value,key);
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            unsafeSchemaJson(row,`${path}[${index}]`,"array items must be enumerable data properties");
          }
          visit(descriptor.value,`${path}[${index}]`);
        }
        return;
      }

      if (Object.getPrototypeOf(value)!==Object.prototype) {
        unsafeSchemaJson(row,path,"objects must use Object.prototype");
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key!=="string") {
          unsafeSchemaJson(row,path,"symbol keys are unsupported");
        }
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          unsafeSchemaJson(row,`${path}.${key}`,"properties must be own enumerable data properties");
        }
        if (key==="$ref") {
          const reference=externalReference(descriptor.value,row,`${path}.$ref`);
          if (reference!==undefined && !seenReferences.has(reference)) {
            seenReferences.add(reference);
            references.push(reference);
          }
        } else {
          visit(descriptor.value,`${path}.${key}`);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  }

  visit(schema,"$");
  return references;
}

function loadClosure(row,byUri,loaded,readSchema,observe) {
  const visitState=new Map();
  const registrationOrder=[];

  function visit(currentRow) {
    const state=visitState.get(currentRow.uri);
    if (state==="visiting" || state==="visited") return;
    visitState.set(currentRow.uri,"visiting");

    let entry=loaded.get(currentRow.uri);
    if (!entry) {
      const schema=observed("schema_io",observe,currentRow,() => readSchema(currentRow));
      verifySchemaIdentity(schema,currentRow);
      const references=observed(
        "dependency_discovery",
        observe,
        currentRow,
        () => discoverExternalReferences(schema,currentRow),
      );
      entry={schema,references};
      loaded.set(currentRow.uri,entry);
    }

    for (const reference of entry.references) {
      const dependencyRow=byUri.get(reference);
      if (!dependencyRow) {
        schemaError(currentRow,`unresolved schema reference: ${reference}`);
      }
      visit(dependencyRow);
    }
    visitState.set(currentRow.uri,"visited");
    registrationOrder.push({row:currentRow,schema:entry.schema});
  }

  visit(row);
  return registrationOrder;
}

function canonicalJsonError(error) {
  return [{
    instancePath:"",
    schemaPath:"#",
    keyword:"canonical-json",
    params:{},
    message:error instanceof Error ? error.message : "Value is not canonical JSON",
  }];
}

function normalizedValidation(validate,value) {
  let document;
  try {
    document=JSON.parse(canonicalJson(value));
  } catch (error) {
    return {valid:false,errors:canonicalJsonError(error)};
  }
  const valid=Boolean(validate(document));
  if (valid) return {valid:true,errors:[]};
  return {
    valid:false,
    errors:JSON.parse(canonicalJson(validate.errors ?? [])),
  };
}

export function createValidatorRuntime({catalog,readSchema,createAjv,observe=() => {}}) {
  const rows=validateContractSchemaCatalog(catalog);
  if (typeof readSchema!=="function" || typeof createAjv!=="function" ||
      typeof observe!=="function") {
    throw new TypeError("validator runtime dependencies must be functions");
  }
  const byId=new Map(rows.map(row => [row.schemaId,row]));
  const byUri=new Map(rows.map(row => [row.uri,row]));
  const loaded=new Map();
  const registered=new Set();
  const compiled=new Map();
  const firstValidated=new Set();
  let ajv;

  function validateDocument(value,schemaId) {
    const row=byId.get(schemaId);
    if (!row) throw new Error(`Unknown contract schema: ${String(schemaId)}`);

    let validate=compiled.get(row.uri);
    if (!validate) {
      const registrationOrder=loadClosure(row,byUri,loaded,readSchema,observe);
      if (!ajv) {
        ajv=observed("ajv_creation",observe,{},() => createAjv());
      }
      for (const dependency of registrationOrder) {
        if (registered.has(dependency.row.uri)) continue;
        observed(
          "schema_registration",
          observe,
          dependency.row,
          () => ajv.addSchema(dependency.schema),
        );
        registered.add(dependency.row.uri);
      }
      validate=observed("compilation",observe,row,() => ajv.getSchema(row.uri));
      if (typeof validate!=="function") {
        throw new TypeError(`Contract schema failed to compile: ${row.schemaId}`);
      }
      compiled.set(row.uri,validate);
    }

    if (!firstValidated.has(row.uri)) {
      const result=observed(
        "first_validation",
        observe,
        row,
        () => normalizedValidation(validate,value),
      );
      firstValidated.add(row.uri);
      return result;
    }
    return normalizedValidation(validate,value);
  }

  return Object.freeze({validateDocument});
}
