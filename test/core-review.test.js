import assert from "node:assert/strict";
import test from "node:test";

import {canonicalJson,sha256Canonical} from "../src/contracts/acp.js";
import {runReviewCommand} from "../src/core/commands/review.js";
import {dispatchCoreCommand,parseCoreCommand} from "../src/core/commands/router.js";
import {
  assertIndependentReviewer,
  normalizeReviewResult,
  reviewFreshness,
  validateImplementationIdentity,
} from "../src/core/domain/review.js";
import {CoreConflictError,CoreValidationError} from "../src/core/errors.js";
import {createOperationRunner} from "../src/core/operations/runner.js";
import {
  REVIEW_MARKERS,
  parseManagedReviewBlock,
  renderManagedReviewBlock,
  updateManagedReviewBlock,
} from "../src/core/review/body.js";
import {
  recordReview,
  reviewFollowUpMarker,
  reviewObservationRevision,
  reviewStatus,
} from "../src/core/review/recorder.js";
import {createCoreGithubFixture} from "./support/core-github-fixture.js";

const REPOSITORY="TOSS-Soft/toss-cli";
const OTHER_REPOSITORY="TOSS-Soft/toss-console";
const BASE_HEAD="0".repeat(40);
const HISTORY_HEAD="9".repeat(40);
const HEAD_A="a".repeat(40);
const HEAD_B="b".repeat(40);
const NOW="2026-09-03T08:00:00.000Z";
const LATER="2026-09-03T09:00:00.000Z";
const EARLIER="2026-09-03T07:55:00.000Z";
const HASH_A="a".repeat(64);

function deeplyFrozen(value,seen=new Set()) {
  if (value===null || typeof value!=="object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every(key => deeplyFrozen(value[key],seen));
}

function result(overrides={}) {
  return {
    schema_version:"review-result.v1",
    review_id:"REVIEW-20260903-0001",
    repository:REPOSITORY,
    pull_request_number:91,
    reviewed_revision:HEAD_A,
    reviewer:{identity:"independent-reviewer",role:"independent-reviewer"},
    verdict:"APPROVED",
    freshness:"CURRENT",
    findings:[],
    unresolved:[],
    verification_evidence:["node --test test/core-review.test.js"],
    follow_up_issues:[],
    reviewed_at:EARLIER,
    recorded_at:NOW,
    ...overrides,
  };
}

function workSnapshot({head=HEAD_A,review=null,checks={state:"PASSED",revision:head}}={}) {
  const branch="issue/43-record-review";
  const base="epic/42-organizational-lifecycle";
  return {
    schema_version:"work-state-snapshot.v1",
    item:{
      schema_version:"work-item.v1",id:`${REPOSITORY}#43`,repository:REPOSITORY,
      issue_number:43,kind:"issue",parent_id:`${REPOSITORY}#42`,
      acceptance_criteria:["The current revision review is recorded."],
      branch,base_branch:base,milestone:"v2.2.0",status:"In review",gate:"REVIEW_REQUIRED",
    },
    issue_state:"OPEN",drifted:false,epic_required:false,prepared:null,scope_approved:null,
    parent:{id:`${REPOSITORY}#42`,branch:base,revision:"parent-1"},
    release:{
      assigned:true,active:true,id:`${REPOSITORY}@release/v2.2.0`,repository:REPOSITORY,
      branch:"release/v2.2.0",milestone:"v2.2.0",revision:"release-1",
    },
    blocking_dependencies:[],children_complete:null,
    physical_branch:{exists:true,head_sha:head},
    pull_request:{state:"READY",head_sha:head,merged_sha:null},
    review,
    checks,
    authority:{epic_acceptance_required:false,release_approval_required:false},
    project:{
      project_id:"PVT_TOSS_OS_2",item_id:"PVTI_43",revision:"project-1",
      fields:{
        Status:"In review",Gate:review?.verdict==="CHANGES_REQUESTED" ? "CHANGES_REQUESTED" :
          review?.reviewed_revision===head && review?.verdict==="APPROVED" && checks?.state==="PASSED" ? "NONE" : "REVIEW_REQUIRED",
        branch,base_branch:base,last_reconciled_at:NOW,
      },
    },
  };
}

function implementationIdentity(overrides={}) {
  const revision=overrides.revision ?? HEAD_A;
  const commits=overrides.commits ?? [
    {revision:HISTORY_HEAD,author:"first-author",committer:"first-committer"},
    {revision:HEAD_A,author:"implementation-author",committer:"merge-committer"},
    ...(revision===HEAD_A ? [] : [{
      revision,author:"implementation-author",committer:"merge-committer",
    }]),
  ];
  const sorted=[...commits].sort((left,right) => left.revision.localeCompare(right.revision));
  return {
    base_revision:BASE_HEAD,
    revision,
    pull_request_author:"implementation-author",
    commit_count:commits.length,
    commits_sha256:sha256Canonical(sorted),
    commits,
    ...overrides,
  };
}

function pullRequest(overrides={}) {
  const head=overrides.head_sha ?? HEAD_A;
  const identityEvidence=overrides.implementationIdentityEvidence ??
    implementationIdentity({revision:head});
  const nativeRevision=overrides.native_revision ?? "pull-request-1";
  const checks=overrides.checks ?? {state:"PASSED",revision:head};
  const publicOverrides={...overrides};
  delete publicOverrides.implementationIdentityEvidence;
  return {
    repository:REPOSITORY,
    number:91,
    native_revision:nativeRevision,
    revision:reviewObservationRevision({
      native_revision:nativeRevision,checks,implementation_identity:identityEvidence,
    }),
    head_repository:REPOSITORY,
    base_repository:REPOSITORY,
    head:"issue/43-record-review",
    base:"epic/42-organizational-lifecycle",
    head_sha:head,
    body:"Human introduction.",
    formal_review:{state:"NONE",review_id:null,reviewed_revision:null},
    recorded_result:null,
    checks,
    work:workSnapshot({head}),
    ...publicOverrides,
  };
}

function project(overrides={}) {
  return {
    project_id:"PVT_TOSS_OS_2",
    item_id:"PVTI_43",
    revision:"project-1",
    follow_up_mappings:[],
    reservations:[],
    ...overrides,
  };
}

function recording(overrides={}) {
  const identity=overrides.implementationIdentity ?? implementationIdentity();
  return {
    pullRequest:pullRequest({implementationIdentityEvidence:identity}),
    result:result(),
    implementationIdentity:identity,
    project:project(),
    ...overrides,
  };
}

function statusInput(value) {
  return {
    pullRequest:value.pullRequest,
    implementationIdentity:value.implementationIdentity,
    project:value.project,
  };
}

function unresolvedFinding({findingId="FINDING-minor",severity="Minor",summary="Document the remaining edge case."}={}) {
  return {finding_id:findingId,severity,summary,resolved:false};
}

function followUpMapping(review=result(),finding=unresolvedFinding(),issueNumber=99,overrides={}) {
  const issueId=`${REPOSITORY}#${issueNumber}`;
  return {
    review_id:review.review_id,
    finding_id:finding.finding_id,
    issue_id:issueId,
    repository:REPOSITORY,
    project_id:"PVT_TOSS_OS_2",
    project_item_id:`PVTI_FOLLOW_UP_${issueNumber}`,
    issue_revision:`issue-${issueNumber}-1`,
    project_revision:"project-1",
    marker:reviewFollowUpMarker(review.review_id,finding.finding_id),
    ...overrides,
  };
}

function reservation(findingId="FINDING-minor",issueNumber=44,overrides={}) {
  return boundReservation(
    result(),unresolvedFinding({findingId}),pullRequest(),project(),issueNumber,overrides,
  );
}

function boundReservation(review,finding,pull,projectEvidence,issueNumber=44,overrides={}) {
  return {
    review_id:review.review_id,
    finding_id:finding.finding_id,
    source_pull_request_repository:pull.repository,
    source_pull_request_number:pull.number,
    source_pull_request_revision:pull.revision,
    source_pull_request_head:pull.head_sha,
    reviewed_repository:review.repository,
    project_id:projectEvidence.project_id,
    project_item_id:projectEvidence.item_id,
    project_revision:projectEvidence.revision,
    issue_number:issueNumber,
    repository:review.repository,
    repository_revision:"repository-1",
    ...overrides,
  };
}

function memoryControl() {
  let head="control-1";
  const intents=new Map();
  const receipts=new Map();
  const events=[];
  return Object.freeze({
    events,
    async head() { return head; },
    async findIntent(value) { return intents.get(value.intent_id) ?? null; },
    async findReceipt(value) { return receipts.get(value.intent_id) ?? null; },
    async commitIntent({expectedHead,intent}) {
      assert.equal(expectedHead,head);
      intents.set(intent.intent_id,structuredClone(intent));
      events.push({kind:"intent",value:structuredClone(intent)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
    async commitReceipt({expectedHead,receipt}) {
      assert.equal(expectedHead,head);
      receipts.set(receipt.intent_id,structuredClone(receipt));
      events.push({kind:"receipt",value:structuredClone(receipt)});
      head=`control-${events.length+1}`;
      return {commit_sha:head};
    },
  });
}

function harness({reviewResult=result(),snapshot=recording()}={}) {
  const fixture=createCoreGithubFixture();
  fixture.seedReviewPullRequest(snapshot);
  const control=memoryControl();
  let sequence=0;
  const runner=createOperationRunner({
    control,github:fixture.github,authorityRegistry:{keys:[]},clock:() => NOW,
    idGenerator:kind => {
      sequence+=1;
      return `${kind==="intent" ? "INTENT" : "RECEIPT"}-20260903-${String(sequence).padStart(4,"0")}`;
    },
    policyRevision:() => "POLICY-0001",
  });
  const services=Object.freeze({
    github:fixture.github,operations:runner,clock:() => NOW,
    async readInput(path) {
      if (path!=="review.json") throw new Error(`missing input ${path}`);
      return structuredClone(reviewResult);
    },
  });
  return {fixture,control,runner,services};
}

function command(argv) { return parseCoreCommand(argv); }

test("managed review body inserts and replaces one canonical block while preserving outside bytes",() => {
  const review=result();
  const rendered=renderManagedReviewBlock(review);
  assert.equal(rendered.startsWith(`${REVIEW_MARKERS.start}\n## Review results\n\n`),true);
  assert.equal(rendered.endsWith(REVIEW_MARKERS.end),true);
  assert.match(rendered,/- Verdict: APPROVED\n/u);
  assert.match(rendered,/- Critical: 0\n- Important: 0\n- Minor: 0\n/u);
  assert.match(rendered,/### Unresolved\n- None\n/u);
  assert.match(rendered,/### Follow-up issues\n- None\n/u);
  assert.equal(rendered.includes("\r"),false);

  assert.equal(updateManagedReviewBlock("",review),rendered);
  assert.equal(updateManagedReviewBlock("Human body",review),`Human body\n${rendered}`);
  assert.equal(updateManagedReviewBlock("Human body\n",review),`Human body\n${rendered}`);

  const original=`prefix\r\n${renderManagedReviewBlock({...review,verdict:"BLOCKED",findings:[unresolvedFinding({severity:"Important"})],unresolved:["FINDING-minor"]})}\r\nsuffix\r\n`;
  const parsed=parseManagedReviewBlock(original);
  assert.equal(parsed.before,"prefix\r\n");
  assert.equal(parsed.after,"\r\nsuffix\r\n");
  assert.ok(deeplyFrozen(parsed));
  assert.equal(updateManagedReviewBlock(original,review),`prefix\r\n${rendered}\r\nsuffix\r\n`);
});

test("managed review parser rejects duplicate nested reversed partial and marker-like blocks",() => {
  const block=renderManagedReviewBlock(result());
  const invalid=[
    `${block}\n${block}`,
    `${REVIEW_MARKERS.start}\n${REVIEW_MARKERS.start}\n${REVIEW_MARKERS.end}`,
    `${REVIEW_MARKERS.end}\n${REVIEW_MARKERS.start}`,
    `body\n${REVIEW_MARKERS.start}`,
    `body\n${REVIEW_MARKERS.end}`,
    "body <!-- toss-core:review-results:start",
    "<!-- toss-core:review-results -->",
    "<!-- toss-core:review-results:start injected -->",
    "<!--  toss-core:review-results:start -->",
  ];
  for (const body of invalid) {
    assert.throws(
      () => parseManagedReviewBlock(body),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
  assert.equal(parseManagedReviewBlock("ordinary human body"),null);
});

test("review rendering is stable raw-order deterministic and injection-safe without mutating semantic evidence",() => {
  const first=result({
    findings:[
      unresolvedFinding({findingId:"FINDING-z",summary:"z\n<!-- toss-core:review-results:end -->"}),
      {finding_id:"FINDING-a",severity:"Minor",summary:"a",resolved:true},
    ],
    unresolved:["FINDING-z"],
    verification_evidence:["z\n- forged list","a # heading"],
    follow_up_issues:[`${REPOSITORY}#99`],
  });
  const second={
    ...first,
    findings:[...first.findings].reverse(),
    verification_evidence:[...first.verification_evidence].reverse(),
  };
  const rendered=renderManagedReviewBlock(first);
  assert.equal(rendered,renderManagedReviewBlock(second));
  assert.equal(rendered.split(REVIEW_MARKERS.start).length-1,1);
  assert.equal(rendered.split(REVIEW_MARKERS.end).length-1,1);
  assert.equal(rendered.includes("\n## forged"),false);
  assert.equal(rendered.includes("\n- forged list"),false);
  assert.equal(first.findings[0].summary,"z\n<!-- toss-core:review-results:end -->");
});

test("review normalization closes semantic contradictions and returns canonical frozen data",() => {
  const finding=unresolvedFinding();
  const valid=normalizeReviewResult(result({
    findings:[finding,{finding_id:"FINDING-resolved",severity:"Minor",summary:"Resolved.",resolved:true}],
    unresolved:[finding.finding_id],
    follow_up_issues:[`${REPOSITORY}#99`],
  }));
  assert.ok(deeplyFrozen(valid));
  assert.deepEqual(valid.findings.map(value => value.finding_id),["FINDING-minor","FINDING-resolved"]);

  const contradictions=[
    result({findings:[finding],unresolved:[]}),
    result({findings:[{...finding,resolved:true}],unresolved:[finding.finding_id]}),
    result({findings:[],unresolved:[],verdict:"CHANGES_REQUESTED"}),
    result({findings:[finding,{...finding,finding_id:"FINDING-two"}],unresolved:[finding.finding_id,"FINDING-two"],verdict:"BLOCKED"}),
    result({findings:[finding,{...finding,finding_id:"FINDING-two",summary:" document the remaining edge case. "}],unresolved:[finding.finding_id,"FINDING-two"],verdict:"BLOCKED"}),
    result({findings:[finding],unresolved:[finding.finding_id],follow_up_issues:[`${REPOSITORY}#99`,`${REPOSITORY}#100`],verdict:"BLOCKED"}),
    result({reviewed_at:"2026-09-03T08:01:00.000Z",recorded_at:NOW}),
  ];
  for (const value of contradictions) {
    assert.throws(() => normalizeReviewResult(value),CoreValidationError);
  }
});

test("review freshness validates exact lowercase SHAs and compares exact bytes",() => {
  assert.equal(reviewFreshness(result(),HEAD_A),"CURRENT");
  assert.equal(reviewFreshness(result(),HEAD_B),"STALE");
  for (const [review,current] of [
    [result({reviewed_revision:"A".repeat(40)}),HEAD_A],
    [result(),"a".repeat(39)],
    [result(),"A".repeat(40)],
  ]) assert.throws(() => reviewFreshness(review,current),CoreValidationError);
});

test("reviewer independence uses case-insensitive revision-pinned author and committer evidence",() => {
  const evidence=implementationIdentity();
  assert.equal(assertIndependentReviewer("unrelated-reviewer",evidence),true);
  for (const identity of ["IMPLEMENTATION-AUTHOR","First-Author","MERGE-COMMITTER"]) {
    assert.throws(
      () => assertIndependentReviewer(identity,evidence),
      error => error.exitCode===4 && /independent/i.test(error.message),
    );
  }
  assert.throws(
    () => assertIndependentReviewer("independent-reviewer",{
      ...evidence,revision:"c".repeat(40),
    }),
    CoreValidationError,
  );
});

test("review identities reject invisible whitespace control format and non-ASCII confusable values",() => {
  const invalidIdentities=[
    "reviewer\nother","reviewer\tother","reviewer\u200b","reviewer\u2060",
    "r\u00e9viewer","\uff52eviewer",
  ];
  for (const identity of invalidIdentities) {
    assert.throws(
      () => normalizeReviewResult(result({
        reviewer:{identity,role:"independent-reviewer"},
      })),
      CoreValidationError,
    );
    assert.throws(
      () => validateImplementationIdentity(implementationIdentity({
        pull_request_author:identity,
      })),
      CoreValidationError,
    );
  }
});

test("implementation identity requires revision-bound complete commit count and canonical digest proof",() => {
  const commits=[
    {revision:HEAD_A,author:"implementation-author",committer:"merge-committer"},
    {revision:"c".repeat(40),author:"historical-author",committer:"historical-committer"},
  ];
  const complete={
    base_revision:"0".repeat(40),revision:HEAD_A,
    pull_request_author:"implementation-author",
    commit_count:2,commits_sha256:sha256Canonical(commits),commits,
  };
  const validated=validateImplementationIdentity(complete);
  assert.equal(validated.commit_count,2);
  assert.equal(validated.commits_sha256,sha256Canonical(commits));
  assert.throws(
    () => assertIndependentReviewer("HISTORICAL-COMMITTER",complete),
    error => error.exitCode===4,
  );

  const invalid=[
    {...complete,commits:commits.slice(1)},
    {...complete,commit_count:1},
    {...complete,commits_sha256:"0".repeat(64)},
    {...complete,base_revision:HEAD_A},
    {...complete,revision:"d".repeat(40)},
    {...complete,commits:[...commits,commits[1]],commit_count:3,
      commits_sha256:sha256Canonical([...commits,commits[1]])},
  ];
  for (const value of invalid) {
    assert.throws(() => validateImplementationIdentity(value),CoreValidationError);
  }
});

test("recordReview binds exact PR identity head checks and independent evidence before producing intent operations",() => {
  const cases=[
    recording({result:result({repository:OTHER_REPOSITORY})}),
    recording({result:result({pull_request_number:92})}),
    recording({result:result({reviewed_revision:HEAD_B,freshness:"STALE"})}),
    recording({implementationIdentity:implementationIdentity({revision:HEAD_B})}),
    recording({result:result({reviewer:{identity:"FIRST-AUTHOR",role:"independent-reviewer"}})}),
    recording({pullRequest:pullRequest({checks:{state:"PASSED",revision:HEAD_B}})}),
    recording({pullRequest:pullRequest({base_repository:OTHER_REPOSITORY})}),
  ];
  for (const value of cases) assert.throws(() => recordReview(value),error => [4,5,6].includes(error.exitCode));

  const operations=recordReview(recording());
  assert.ok(deeplyFrozen(operations));
  assert.deepEqual(operations.map(value => `${value.resource}.${value.action}`),[
    "project.update","pull_request.update",
  ]);
  const pull=operations.find(value => value.resource==="pull_request");
  assert.equal(pull.expected_revision,pullRequest().revision);
  assert.equal(pull.payload.formal_review.action,"APPROVE");
  assert.equal(pull.payload.head_sha,HEAD_A);
  assert.equal(canonicalJson(pull.payload.review_result),canonicalJson(result()));
  assert.equal(canonicalJson(pull.payload.implementation_identity),canonicalJson(implementationIdentity()));
  const projectUpdate=operations.find(value => value.resource==="project");
  assert.equal(projectUpdate.payload.fields.Gate,"NONE");
  assert.equal(projectUpdate.payload.review_context.head_sha,HEAD_A);
  assert.equal(canonicalJson(projectUpdate.payload.review_context.review_result),canonicalJson(result()));
});

test("unresolved Critical or Important findings request changes and produce the same-intent blocking Project gate",() => {
  for (const severity of ["Critical","Important"]) {
    const finding=unresolvedFinding({severity});
    const review=result({verdict:"CHANGES_REQUESTED",findings:[finding],unresolved:[finding.finding_id]});
    const operations=recordReview(recording({result:review}));
    const pull=operations.find(value => value.resource==="pull_request");
    const projectUpdate=operations.find(value => value.resource==="project");
    assert.equal(pull.payload.formal_review.action,"REQUEST_CHANGES",severity);
    assert.equal(projectUpdate.payload.fields.Status,"Blocked",severity);
    assert.equal(projectUpdate.payload.fields.Gate,"CHANGES_REQUESTED",severity);
  }
});

test("every unresolved Minor reuses exactly one governed follow-up or creates it from a pinned reservation",() => {
  const finding=unresolvedFinding();
  const createdInput=result({findings:[finding],unresolved:[finding.finding_id]});
  const created=recordReview(recording({
    result:createdInput,
    project:project({reservations:[reservation()]}),
  }));
  assert.deepEqual(created.map(value => `${value.resource}.${value.action}`),[
    "issue.create","project.create","project.update","pull_request.update",
  ]);
  const issueCreate=created.find(value => value.resource==="issue");
  assert.equal(issueCreate.payload.issue_id,`${REPOSITORY}#44`);
  assert.equal(issueCreate.payload.reserved_branch,"issue/44-document-the-remaining-edge-case");
  assert.equal(issueCreate.payload.marker,reviewFollowUpMarker(createdInput.review_id,finding.finding_id));
  assert.deepEqual(
    issueCreate.payload.review_context.review_result.follow_up_issues,
    [`${REPOSITORY}#44`],
  );
  const finalResult=created.find(value => value.resource==="pull_request").payload.review_result;
  assert.deepEqual(finalResult.follow_up_issues,[`${REPOSITORY}#44`]);
  assert.equal(
    created.find(value => value.resource==="pull_request").payload.formal_review.action,
    "APPROVE",
  );
  assert.equal(
    created.find(value => value.resource==="project" && value.action==="update").payload.fields.Gate,
    "NONE",
  );

  const reusedInput=result({
    findings:[finding],unresolved:[finding.finding_id],follow_up_issues:[`${REPOSITORY}#99`],
  });
  const reused=recordReview(recording({
    result:reusedInput,
    project:project({follow_up_mappings:[followUpMapping(reusedInput,finding)]}),
  }));
  assert.equal(reused.some(value => value.resource==="issue"),false);
  assert.equal(reused.filter(value => value.resource==="project" && value.action==="create").length,0);
});

test("unmanaged duplicate wrong-project wrong-finding and cross-repository follow-up evidence conflicts",() => {
  const finding=unresolvedFinding();
  const review=result({
    findings:[finding],unresolved:[finding.finding_id],follow_up_issues:[`${REPOSITORY}#99`],
  });
  const base=followUpMapping(review,finding);
  const projects=[
    project(),
    project({follow_up_mappings:[base,base]}),
    project({follow_up_mappings:[base],reservations:[reservation()]}),
    project({follow_up_mappings:[{...base,project_id:"PVT_OTHER"}]}),
    project({follow_up_mappings:[{...base,finding_id:"FINDING-other"}]}),
    project({follow_up_mappings:[{...base,issue_id:`${OTHER_REPOSITORY}#99`,repository:OTHER_REPOSITORY}]}),
  ];
  for (const projectEvidence of projects) {
    assert.throws(
      () => recordReview(recording({result:review,project:projectEvidence})),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
});

test("one Minor cannot carry both a governed mapping and a new-number reservation",() => {
  const finding=unresolvedFinding();
  const review=result({
    findings:[finding],unresolved:[finding.finding_id],follow_up_issues:[`${REPOSITORY}#99`],
  });
  assert.throws(
    () => recordReview(recording({
      result:review,
      project:project({
        follow_up_mappings:[followUpMapping(review,finding)],
        reservations:[reservation()],
      }),
    })),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
});

test("exact replay is a no-op while body formal-state and follow-up drift conflict",() => {
  const review=result();
  const work=workSnapshot({review:{verdict:"APPROVED",reviewed_revision:HEAD_A}});
  const current=pullRequest({
    body:updateManagedReviewBlock("Human introduction.",review),
    formal_review:{state:"APPROVED",review_id:review.review_id,reviewed_revision:HEAD_A},
    recorded_result:review,
    work,
  });
  assert.deepEqual(recordReview(recording({pullRequest:current,result:review})),[]);

  for (const changed of [
    {...current,body:current.body.replace("- Verdict: APPROVED","- Verdict: BLOCKED")},
    {...current,formal_review:{state:"CHANGES_REQUESTED",review_id:review.review_id,reviewed_revision:HEAD_A}},
    {...current,recorded_result:{...review,review_id:"REVIEW-20260903-0002"}},
  ]) assert.throws(() => recordReview(recording({pullRequest:changed,result:review})),CoreConflictError);
});

test("status recomputes stale freshness after a push and reports body formal and Project drift",() => {
  const prior=result();
  const body=updateManagedReviewBlock("Human introduction.",prior);
  const pushed=pullRequest({
    head_sha:HEAD_B,
    body,
    formal_review:{state:"APPROVED",review_id:prior.review_id,reviewed_revision:HEAD_A},
    recorded_result:prior,
    checks:{state:"PENDING",revision:HEAD_B},
    work:workSnapshot({
      head:HEAD_B,
      review:{verdict:"APPROVED",reviewed_revision:HEAD_A},
      checks:{state:"PENDING",revision:HEAD_B},
    }),
  });
  const status=reviewStatus(statusInput(recording({
    pullRequest:pushed,result:prior,
    implementationIdentity:implementationIdentity({revision:HEAD_B}),
  })));
  assert.equal(status.freshness,"STALE");
  assert.equal(status.formal_review.state,"APPROVED");
  assert.equal(status.checks.state,"PENDING");
  assert.equal(status.merge_eligible,false);
  assert.equal(status.state.gate,"REVIEW_REQUIRED");
  assert.equal(status.next_command,"toss-core review record");
  assert.ok(deeplyFrozen(status));

  const becameImplementer=implementationIdentity({
    revision:HEAD_B,
    commits:[
      {revision:HEAD_A,author:"implementation-author",committer:"merge-committer"},
      {revision:HEAD_B,author:"independent-reviewer",committer:"independent-reviewer"},
    ],
  });
  const pushedWithBecameImplementer={
    ...pushed,
    revision:reviewObservationRevision({
      native_revision:pushed.native_revision,checks:pushed.checks,
      implementation_identity:becameImplementer,
    }),
  };
  assert.equal(reviewStatus(statusInput(recording({
    pullRequest:pushedWithBecameImplementer,result:prior,implementationIdentity:becameImplementer,
  }))).freshness,"STALE");

  const bodyDrift={...pushed,body:"Human introduction."};
  assert.throws(() => reviewStatus(statusInput(recording({
    pullRequest:bodyDrift,result:prior,
    implementationIdentity:implementationIdentity({revision:HEAD_B}),
  }))),CoreConflictError);

  const projectDrift=structuredClone(pushed);
  projectDrift.work.project.fields.Gate="NONE";
  const drift=reviewStatus(statusInput(recording({
    pullRequest:projectDrift,result:prior,
    implementationIdentity:implementationIdentity({revision:HEAD_B}),
  })));
  assert.equal(drift.reconciliation,"RECONCILE_REQUIRED");
  assert.equal(drift.next_command,"toss-core sync");
});

test("stored review control evidence rejects foreign pull requests repositories and recorded STALE state",() => {
  for (const stored of [
    result({repository:OTHER_REPOSITORY}),
    result({pull_request_number:92}),
    result({freshness:"STALE"}),
  ]) {
    const current=pullRequest({
      body:updateManagedReviewBlock("Human introduction.",stored),
      formal_review:{
        state:"APPROVED",review_id:stored.review_id,
        reviewed_revision:stored.reviewed_revision,
      },
      recorded_result:stored,
      work:workSnapshot({review:{
        verdict:stored.verdict,reviewed_revision:stored.reviewed_revision,
      }}),
    });
    assert.throws(
      () => reviewStatus(statusInput(recording({pullRequest:current,result:stored}))),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }
});

test("recording rejects stale checks while current pending checks can record approval without merge eligibility",() => {
  const staleChecks={state:"PASSED",revision:HEAD_B};
  assert.throws(
    () => recordReview(recording({pullRequest:pullRequest({
      checks:staleChecks,work:workSnapshot({checks:staleChecks}),
    })})),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );

  const pending={state:"PENDING",revision:HEAD_A};
  const operations=recordReview(recording({pullRequest:pullRequest({
    checks:pending,work:workSnapshot({checks:pending}),
  })}));
  const pull=operations.find(value => value.resource==="pull_request");
  assert.equal(pull.payload.formal_review.action,"APPROVE");
  const stored=result();
  const currentPull=pullRequest({
    body:updateManagedReviewBlock("Human introduction.",stored),
    formal_review:{state:"APPROVED",review_id:stored.review_id,reviewed_revision:HEAD_A},
    recorded_result:stored,checks:pending,
    work:workSnapshot({review:{verdict:"APPROVED",reviewed_revision:HEAD_A},checks:pending}),
  });
  const status=reviewStatus(statusInput(recording({pullRequest:currentPull,result:stored})));
  assert.equal(status.merge_eligible,false);
  assert.equal(status.state.gate,"REVIEW_REQUIRED");
});

test("review PR CAS detects check and identity mutations after snapshot and fake apply cannot overwrite them",async () => {
  for (const mutation of ["checks","identity"]) {
    const state=harness();
    const observed=await state.fixture.github.snapshot({
      kind:"review",repository:REPOSITORY,number:91,
    });
    const operations=recordReview({
      pullRequest:observed.pullRequest,result:result(),
      implementationIdentity:observed.implementationIdentity,project:observed.project,
    });
    const changedChecks=mutation==="checks"
      ? {state:"FAILED",revision:HEAD_A}
      : observed.pullRequest.checks;
    const changedIdentity=mutation==="identity"
      ? implementationIdentity({pull_request_author:"different-author"})
      : observed.implementationIdentity;
    if (mutation==="checks") {
      state.fixture.setReviewChecks(REPOSITORY,91,changedChecks);
    } else {
      state.fixture.setReviewImplementationIdentity(REPOSITORY,91,changedIdentity);
    }
    await assert.rejects(
      state.runner.execute({
        command:command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),
        source:observed.source,operations,authority:null,
      }),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
    const retained=state.fixture.view().repositories[0].pull_requests[0];
    assert.equal(canonicalJson(retained.checks),canonicalJson(changedChecks));
    assert.equal(canonicalJson(retained.implementation_identity),canonicalJson(changedIdentity));
  }
});

test("fake review apply verifies embedded check and identity evidence without treating it as writable state",async () => {
  for (const mutation of ["checks","identity"]) {
    const state=harness();
    const observed=await state.fixture.github.snapshot({
      kind:"review",repository:REPOSITORY,number:91,
    });
    const operations=recordReview({
      pullRequest:observed.pullRequest,result:result(),
      implementationIdentity:observed.implementationIdentity,project:observed.project,
    });
    const planned=operations.find(value => value.resource==="pull_request");
    const forgedPayload=mutation==="checks" ? {
      ...planned.payload,checks:{state:"FAILED",revision:HEAD_A},
    } : {
      ...planned.payload,
      implementation_identity:implementationIdentity({pull_request_author:"different-author"}),
    };
    await assert.rejects(
      state.fixture.github.apply([{
        ...planned,operation_id:`OPERATION-20260903-${mutation==="checks" ? "0001" : "0002"}`,
        payload:forgedPayload,
      }],{idempotencyKey:mutation==="checks" ? HASH_A : "b".repeat(64)}),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
    const retained=state.fixture.view().repositories[0].pull_requests[0];
    assert.equal(retained.checks.state,"PASSED");
    assert.equal(retained.implementation_identity.pull_request_author,"implementation-author");
  }
});

test("review follow-up reservations bind the review source Project and native issue inventory",async () => {
  const finding=unresolvedFinding();
  const review=result({findings:[finding],unresolved:[finding.finding_id]});
  const pull=pullRequest();
  const projectEvidence=project();
  const reserved=boundReservation(review,finding,pull,projectEvidence);
  const operations=recordReview(recording({
    pullRequest:pull,result:review,
    project:{...projectEvidence,reservations:[reserved]},
  }));
  assert.equal(operations.find(value => value.resource==="issue").payload.issue_id,`${REPOSITORY}#44`);
  for (const changed of [
    {...reserved,review_id:"REVIEW-20260903-0002"},
    {...reserved,source_pull_request_number:92},
    {...reserved,source_pull_request_revision:"other-revision"},
    {...reserved,source_pull_request_head:HEAD_B},
    {...reserved,reviewed_repository:OTHER_REPOSITORY},
    {...reserved,project_id:"PVT_OTHER"},
    {...reserved,project_item_id:"PVTI_OTHER"},
  ]) {
    assert.throws(
      () => recordReview(recording({
        pullRequest:pull,result:review,
        project:{...projectEvidence,reservations:[changed]},
      })),
      error => error instanceof CoreConflictError && error.exitCode===6,
    );
  }

  const state=harness({
    reviewResult:review,
    snapshot:recording({
      pullRequest:pull,result:review,
      project:{...projectEvidence,reservations:[reserved]},
    }),
  });
  await runReviewCommand(
    command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),
    state.services,
  );
  const repository=state.fixture.view().repositories[0];
  assert.equal(repository.issues.some(value => value.work.item.id===`${REPOSITORY}#44`),true);
  assert.equal(repository.next_issue_number,45);
  const replay=await runReviewCommand(
    command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),
    state.services,
  );
  assert.equal(replay.status,"already-reconciled");
  assert.equal(state.fixture.view().repositories[0].issues.length,2);

  const collidingReservation=boundReservation(review,finding,pull,projectEvidence,43);
  const collision=harness({
    reviewResult:review,
    snapshot:recording({
      pullRequest:pull,result:review,
      project:{...projectEvidence,reservations:[collidingReservation]},
    }),
  });
  await assert.rejects(
    runReviewCommand(
      command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),
      collision.services,
    ),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
  assert.equal(collision.fixture.view().repositories[0].issues.length,1);
});

test("record review snapshot requests exact Minor reservations while status requests none",async () => {
  const findingZ=unresolvedFinding({findingId:"FINDING-z",summary:"Z"});
  const findingA=unresolvedFinding({findingId:"FINDING-a",summary:"A"});
  const review=result({findings:[findingZ,findingA],unresolved:[findingZ.finding_id,findingA.finding_id]});
  const pull=pullRequest();
  const projectEvidence=project();
  const reservations=[
    boundReservation(review,findingZ,pull,projectEvidence,45),
    boundReservation(review,findingA,pull,projectEvidence,44),
  ];
  const state=harness({reviewResult:review,snapshot:recording({
    pullRequest:pull,result:review,project:{...projectEvidence,reservations},
  })});
  await runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json"]),state.services);
  assert.equal(canonicalJson(state.fixture.view().calls[0].query),canonicalJson({
    kind:"review",repository:REPOSITORY,number:91,review_id:review.review_id,
    unresolved_minor_finding_ids:["FINDING-a","FINDING-z"],
  }));

  const statusState=harness();
  await runReviewCommand(command(["review","status",`${REPOSITORY}#91`]),statusState.services);
  assert.equal(canonicalJson(statusState.fixture.view().calls[0].query),canonicalJson({
    kind:"review",repository:REPOSITORY,number:91,
  }));

  const shared=boundReservation(review,findingA,pull,projectEvidence,44);
  const sharedAcrossReviews={...shared,review_id:"REVIEW-20260903-0002"};
  const reservedZ=boundReservation(review,findingZ,pull,projectEvidence,45);
  const ambiguous=harness({reviewResult:review,snapshot:recording({
    pullRequest:pull,result:review,
    project:{...projectEvidence,reservations:[shared,sharedAcrossReviews,reservedZ]},
  })});
  await assert.rejects(
    runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json"]),ambiguous.services),
    error => error instanceof CoreConflictError && error.exitCode===6,
  );
});

test("review Project reconciliation preserves newer observed time on replay and state change",() => {
  const review=result();
  const replayWork=workSnapshot({review:{verdict:"APPROVED",reviewed_revision:HEAD_A}});
  replayWork.project.fields.last_reconciled_at=LATER;
  const replayPull=pullRequest({
    body:updateManagedReviewBlock("Human introduction.",review),
    formal_review:{state:"APPROVED",review_id:review.review_id,reviewed_revision:HEAD_A},
    recorded_result:review,work:replayWork,
  });
  assert.deepEqual(recordReview(recording({pullRequest:replayPull,result:review})),[]);

  const changedWork=workSnapshot();
  changedWork.project.fields.last_reconciled_at=LATER;
  const changed=recordReview(recording({pullRequest:pullRequest({work:changedWork})}));
  const fields=changed.find(value => value.resource==="project").payload.fields;
  assert.equal(fields.Gate,"NONE");
  assert.equal(Object.hasOwn(fields,"last_reconciled_at"),false);
});

test("review verdict matrix maps only APPROVED to formal approval and every non-approved verdict to changes",() => {
  const cases=[
    {verdict:"APPROVED",severity:null,formal:"APPROVE",status:"In review",gate:"NONE"},
    {verdict:"CHANGES_REQUESTED",severity:"Important",formal:"REQUEST_CHANGES",status:"Blocked",gate:"CHANGES_REQUESTED"},
    {verdict:"BLOCKED",severity:"Critical",formal:"REQUEST_CHANGES",status:"Blocked",gate:"CHANGES_REQUESTED"},
    {verdict:"CHANGES_REQUESTED",severity:"Minor",formal:"REQUEST_CHANGES",status:"Blocked",gate:"CHANGES_REQUESTED"},
  ];
  for (const expected of cases) {
    const finding=expected.severity===null ? null : unresolvedFinding({severity:expected.severity});
    const review=result({
      verdict:expected.verdict,findings:finding===null ? [] : [finding],
      unresolved:finding===null ? [] : [finding.finding_id],
    });
    const projectEvidence=finding?.severity==="Minor"
      ? project({reservations:[boundReservation(review,finding,pullRequest(),project())]})
      : project();
    const operations=recordReview(recording({result:review,project:projectEvidence}));
    const pull=operations.find(value => value.resource==="pull_request");
    const projectUpdate=operations.find(value => value.resource==="project" && value.action==="update");
    assert.equal(pull.payload.formal_review.action,expected.formal,expected.verdict);
    assert.equal(
      projectUpdate.payload.fields.Status ?? "In review",expected.status,expected.verdict,
    );
    assert.equal(
      projectUpdate.payload.fields.Gate ?? "REVIEW_REQUIRED",expected.gate,expected.verdict,
    );
  }
});

test("review command validates closed nested snapshots and a semantic source hash before dereference",async () => {
  const baseState=harness();
  const base=await baseState.fixture.github.snapshot({kind:"review",repository:REPOSITORY,number:91});
  let traps=0;
  const proxied=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  const accessor={...base};
  Object.defineProperty(accessor,"project",{enumerable:true,get() { traps+=1; return base.project; }});
  const hidden={...base.project};
  Object.defineProperty(hidden,"hidden",{value:true,enumerable:false});
  const symbol={...base.source,[Symbol("hidden")]:true};
  const sparse=[];
  sparse.length=1;
  const malformed=[
    {...base,pullRequest:null},
    {...base,implementationIdentity:proxied},
    accessor,
    {...base,project:hidden},
    {...base,source:symbol},
    {...base,project:{...base.project,reservations:sparse}},
    {...base,source:{...base.source,sha256:"0".repeat(64)}},
    {...base,pullRequest:{...base.pullRequest,body:"tampered after source hash"}},
  ];
  for (const snapshotValue of malformed) {
    const state=harness();
    const services=Object.freeze({
      ...state.services,
      github:Object.freeze({async snapshot() { return snapshotValue; }}),
    });
    await assert.rejects(
      runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json"]),services),
      error => error instanceof CoreValidationError && error.exitCode===5,
    );
  }
  assert.equal(traps,0);
});

test("review commands route one snapshot through the real runner for preview apply no-op and status",async () => {
  const previewState=harness();
  const preview=await runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json"]),previewState.services);
  assert.equal(preview.schema_version,"operation-preview.v1");
  assert.equal(previewState.control.events.length,0);
  assert.deepEqual(previewState.fixture.view().calls.map(value => value.method),["snapshot"]);

  const state=harness();
  const routed=await dispatchCoreCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),{services:state.services});
  assert.equal(routed.exitCode,0);
  assert.deepEqual(state.control.events.map(value => value.kind),["intent","receipt"]);
  assert.deepEqual(state.fixture.view().calls.map(value => value.method),["snapshot","inspect","apply"]);
  const intent=state.control.events[0].value;
  assert.ok(intent.operations.every(value => canonicalJson(value.payload).includes("review-result.v1")));
  assert.ok(intent.operations.every(value => canonicalJson(value.payload).includes("implementation-author")));

  const callsBefore=state.fixture.view().calls.length;
  const replay=await runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),state.services);
  assert.equal(replay.status,"already-reconciled");
  assert.equal(state.control.events.length,2);
  assert.equal(state.fixture.view().calls.length,callsBefore+1);

  const status=await dispatchCoreCommand(command(["review","status",`${REPOSITORY}#91`]),{services:state.services});
  assert.equal(status.exitCode,0);
  assert.equal(status.result.data.freshness,"CURRENT");
  assert.equal(status.result.data.merge_eligible,true);
  assert.ok(deeplyFrozen(status));
});

test("review command preview dry-run declined confirmation and partial observation write only through runner gates",async () => {
  const dry=harness();
  await runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--dry-run"]),dry.services);
  assert.equal(dry.control.events.length,0);
  assert.deepEqual(dry.fixture.view().calls.map(value => value.method),["snapshot"]);

  const declined=harness();
  const declinedServices=Object.freeze({...declined.services,confirm:async () => false});
  await assert.rejects(
    runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply"]),declinedServices),
    error => error.exitCode===4,
  );
  assert.equal(declined.control.events.length,0);
  assert.deepEqual(declined.fixture.view().calls.map(value => value.method),["snapshot"]);

  const partial=harness();
  partial.fixture.setFailureMode("missing-apply-observation");
  await assert.rejects(
    runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),partial.services),
    error => error.exitCode===70,
  );
  assert.deepEqual(partial.control.events.map(value => value.kind),["intent","receipt"]);
  assert.equal(partial.control.events[1].value.status,"failed");
});

test("public review boundaries reject hostile wrappers and service ports without invoking traps",async () => {
  let traps=0;
  const hostile=new Proxy({}, {
    get() { traps+=1; throw new Error("get trap"); },
    getPrototypeOf() { traps+=1; throw new Error("prototype trap"); },
    ownKeys() { traps+=1; throw new Error("keys trap"); },
  });
  assert.throws(() => normalizeReviewResult(hostile),CoreValidationError);
  assert.throws(() => recordReview(hostile),CoreValidationError);
  assert.throws(() => reviewStatus(hostile),CoreValidationError);
  assert.equal(traps,0);

  const state=harness();
  const services={...state.services};
  Object.defineProperty(services,"github",{enumerable:true,get() { traps+=1; return state.services.github; }});
  const dispatched=await dispatchCoreCommand(command(["review","status",`${REPOSITORY}#91`]),{services});
  assert.equal(dispatched.exitCode,5);
  assert.equal(traps,0);
});

test("review status detects a fake new push and never reuses the previous formal approval",async () => {
  const state=harness();
  await runReviewCommand(command(["review","record",`${REPOSITORY}#91`,"--from","review.json","--apply","--non-interactive"]),state.services);
  state.fixture.setPullRequestHead(REPOSITORY,91,HEAD_B,{checks:"PENDING",reconcileProject:true});
  const status=await runReviewCommand(command(["review","status",`${REPOSITORY}#91`]),state.services);
  assert.equal(status.freshness,"STALE");
  assert.equal(status.formal_review.reviewed_revision,HEAD_A);
  assert.equal(status.merge_eligible,false);
  assert.equal(status.state.gate,"REVIEW_REQUIRED");
  assert.equal(status.next_command,"toss-core review record");
});
