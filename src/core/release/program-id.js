import {CoreValidationError} from "../errors.js";

function invalid(message,options={}) {
  throw new CoreValidationError(message,options);
}

export function nextReleaseProgramId(programs) {
  let greatest=0n;
  let width=4;
  for (const program of programs) {
    const match=/^TOSS-OS-R([0-9]{4,})$/u.exec(program?.program_id);
    if (!match) invalid("Persisted release program identity is not canonical");
    let value;
    try { value=BigInt(match[1]); } catch (error) {
      invalid("Persisted release program identity cannot be incremented",{cause:error});
    }
    if (value>greatest) greatest=value;
    width=Math.max(width,match[1].length);
  }
  const next=String(greatest+1n);
  return `TOSS-OS-R${next.padStart(Math.max(width,next.length),"0")}`;
}
