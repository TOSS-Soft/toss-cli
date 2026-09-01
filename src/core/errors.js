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
  }
}
