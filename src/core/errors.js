export class CoreError extends Error {
  constructor(message,{code="CORE_ERROR",cause}={}) {
    super(message,{cause});
    this.name=this.constructor.name;
    this.code=code;
  }
}

export class CoreValidationError extends CoreError {
  constructor(message,options={}) {
    super(message,{code:"CORE_CONTRACT_INVALID",...options});
    this.exitCode=5;
  }
}

export class CoreBlockedError extends CoreError {
  constructor(message,options={}) {
    super(message,{code:"CORE_BLOCKED",...options});
    this.exitCode=4;
  }
}

export class CoreConflictError extends CoreError {
  constructor(message,options={}) {
    super(message,{code:"CORE_CONFLICT",...options});
    this.exitCode=6;
  }
}

export class CoreRemoteError extends CoreError {
  constructor(message,options={}) {
    super(message,{code:"CORE_REMOTE_FAILURE",...options});
    this.exitCode=70;
  }
}

export class CoreInternalError extends CoreError {
  constructor(message,options={}) {
    super(message,{code:"CORE_INTERNAL_FAILURE",...options});
    this.exitCode=70;
  }
}
