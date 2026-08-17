function sourceLabel(provenance) {
  if (provenance?.source) {
    return [
      provenance.source.file,
      provenance.source.section,
      provenance.source.location,
    ].join(" > ");
  }
  if (Array.isArray(provenance?.locations)) return provenance.locations.join(", ");
  return "unknown";
}

function nodeLine(node) {
  return `  ${node.id} [${node.type}] ${node.meaning}`;
}

export function renderTraceHuman(result) {
  const lines=[
    `Trace ${result.entity.id} [${result.entity.type}]`,
    `Meaning: ${result.entity.meaning}`,
    `Source: ${sourceLabel(result.entity.provenance)}`,
    "",
    `Upstream (${result.upstream.length}):`,
    ...(result.upstream.length ? result.upstream.map(nodeLine) : ["  (none)"]),
    "",
    `Downstream (${result.downstream.length}):`,
    ...(result.downstream.length ? result.downstream.map(nodeLine) : ["  (none)"]),
    "",
    `Requirement coverage: ${(result.requirement_coverage*100).toFixed(2)}%`,
  ];
  return lines.join("\n");
}

export function renderTraceJson(result) {
  return JSON.stringify(result,null,2);
}

export function renderTraceError(error,{json=false}={}) {
  const message=error instanceof Error ? error.message : String(error);
  if (!json) return message;
  return JSON.stringify({
    error:{
      code:typeof error?.code==="string" ? error.code : "TRACE_COMMAND_FAILED",
      message,
    },
  });
}
