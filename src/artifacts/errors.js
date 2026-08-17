export class ArtifactStoreError extends Error {
  constructor(message,{code="ARTIFACT_STORE_ERROR",cause}={}) {
    super(message,{cause});
    this.name=this.constructor.name;
    this.code=code;
  }
}

export class ArtifactValidationError extends ArtifactStoreError {
  constructor(message,options={}) {
    super(message,{code:"ARTIFACT_VALIDATION_ERROR",...options});
  }
}

export class ArtifactNotFoundError extends ArtifactStoreError {
  constructor(message,options={}) {
    super(message,{code:"ARTIFACT_NOT_FOUND",...options});
  }
}

export class ArtifactOverwriteError extends ArtifactStoreError {
  constructor(message,options={}) {
    super(message,{code:"ARTIFACT_OVERWRITE",...options});
  }
}

export class ArtifactReferenceError extends ArtifactStoreError {
  constructor(message,options={}) {
    super(message,{code:"ARTIFACT_REFERENCE_ERROR",...options});
  }
}

export class ArtifactIntegrityError extends ArtifactStoreError {
  constructor(message,options={}) {
    super(message,{code:"ARTIFACT_INTEGRITY_ERROR",...options});
  }
}
