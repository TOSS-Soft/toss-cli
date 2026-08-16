import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const root=path.resolve(".");
const cli=path.join(root,"bin","toss.js");
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"toss-overlay-safety-"));

function runCli(args) {
  return spawnSync(process.execPath,[cli,...args],{
    cwd:tmp,
    encoding:"utf8",
  });
}

function writeBrief(file,{name,slug,delivery}) {
  const brief=YAML.parse(
    fs.readFileSync(path.join(root,"templates","project-brief.yaml"),"utf8"),
  );
  brief.project.name=name;
  brief.project.slug=slug;
  brief.project.description="Force-overlay safety fixture";
  brief.business.problem="Prevent hybrid governance output";
  brief.business.primary_goal="Reject ambiguous profile overlays";
  brief.governance.delivery=delivery;
  brief.delivery.create_github_repository=false;
  brief.delivery.create_github_project=false;
  brief.delivery.apply_main_ruleset=false;
  const briefPath=path.join(tmp,file);
  fs.writeFileSync(briefPath,YAML.stringify(brief),"utf8");
  return briefPath;
}

function assertSuccess(result,label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function assertRejected(result,pattern,label) {
  assert.notEqual(result.status,0,`${label} unexpectedly succeeded`);
  assert.match(
    result.stderr,
    pattern,
    `${label} reported the wrong refusal\nstderr:\n${result.stderr}`,
  );
}

try {
  const coreSlug="core-to-delivery-overlay";
  const coreBrief=writeBrief("core.yaml",{
    name:"Core Overlay Project",
    slug:coreSlug,
    delivery:false,
  });
  assertSuccess(runCli(["create",coreBrief]),"initial Core generation");
  const coreProject=path.join(tmp,coreSlug);
  const coreStateBefore=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
  const deliveryBrief=writeBrief("core-to-delivery.yaml",{
    name:"Core Overlay Project",
    slug:coreSlug,
    delivery:true,
  });
  const coreToDelivery=runCli(["create",deliveryBrief,"--force"]);
  assertRejected(
    coreToDelivery,
    /Refusing --force profile overlay from Core to Core\+Delivery/i,
    "Core-to-Delivery force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
    coreStateBefore,
    "Core-to-Delivery refusal mutated project state",
  );
  assert.equal(
    fs.existsSync(path.join(coreProject,"project-management","policies","DELIVERY.md")),
    false,
    "Core-to-Delivery refusal installed Delivery assets",
  );

  const deliverySlug="delivery-to-core-overlay";
  const initialDeliveryBrief=writeBrief("delivery.yaml",{
    name:"Delivery Overlay Project",
    slug:deliverySlug,
    delivery:true,
  });
  assertSuccess(runCli(["create",initialDeliveryBrief]),"initial Delivery generation");
  const deliveryProject=path.join(tmp,deliverySlug);
  const deliveryStateBefore=fs.readFileSync(path.join(deliveryProject,"project.json"),"utf8");
  const deliveryPolicy=path.join(
    deliveryProject,
    "project-management","policies","DELIVERY.md",
  );
  const deliveryPolicyBefore=fs.readFileSync(deliveryPolicy,"utf8");
  const deliveryToCore=runCli([
    "Delivery Overlay Replacement",
    "--slug",deliverySlug,
    "--dir",deliveryProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    deliveryToCore,
    /Refusing --force profile overlay from Core\+Delivery to Core/i,
    "Delivery-to-Core force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(deliveryProject,"project.json"),"utf8"),
    deliveryStateBefore,
    "Delivery-to-Core refusal rewrote project state",
  );
  assert.equal(
    fs.readFileSync(deliveryPolicy,"utf8"),
    deliveryPolicyBefore,
    "Delivery-to-Core refusal rewrote Delivery governance",
  );

  const legacyProject=path.join(tmp,"legacy-v1-project");
  const legacyPolicy=path.join(
    legacyProject,
    "project-management","policies","SECURITY.md",
  );
  fs.mkdirSync(path.dirname(legacyPolicy),{recursive:true});
  fs.writeFileSync(legacyPolicy,"# Project-specific v1 security policy\n","utf8");
  const legacyState={
    governance:{version:"1.6.0",root:"project-management"},
    bootstrap_state:{project_brief:"LOADED"},
  };
  fs.writeFileSync(
    path.join(legacyProject,"project.json"),
    JSON.stringify(legacyState,null,2)+"\n",
    "utf8",
  );
  const legacyStateBefore=fs.readFileSync(path.join(legacyProject,"project.json"),"utf8");
  const legacyToV2=runCli([
    "Legacy v1 Project",
    "--slug","legacy-v1-project",
    "--dir",legacyProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    legacyToV2,
    /Refusing --force.*governance v1.*manual migration/i,
    "v1-to-v2 force overlay",
  );
  assert.equal(
    fs.readFileSync(path.join(legacyProject,"project.json"),"utf8"),
    legacyStateBefore,
    "v1-to-v2 refusal rewrote legacy project state",
  );
  assert.equal(
    fs.readFileSync(legacyPolicy,"utf8"),
    "# Project-specific v1 security policy\n",
    "v1-to-v2 refusal rewrote a populated legacy policy",
  );

  const retiredGeneratedPaths=[
    "project-management/TRUSTED_EVALUATOR_ARCHITECTURE.md",
    ".github/workflows/pm-governance-certification.yml",
    ".github/workflows/request-trusted-governance-evaluation.yml",
    "project-management/CHANGELOG.md",
    "project-management/CLAUDE_CODE_TRAJECTORY_EVAL.md",
    "project-management/DECISIONS.md",
    "project-management/GITHUB_GOVERNANCE_GATE.md",
    "project-management/LANGSMITH_EVAL_CATALOG.md",
    "project-management/LANGSMITH_INTEGRATION.md",
    "project-management/PM_AGENT.md",
    "project-management/PM_GOVERNANCE_BENCHMARK_RUNBOOK.md",
    "project-management/PM_GOVERNANCE_BENCHMARK_V1.md",
    "project-management/PM_GOVERNANCE_CERTIFICATION_STANDARD.md",
    "project-management/RISKS.md",
    "project-management/TRUSTED_EVALUATOR_RUNBOOK.md",
    "project-management/policies/AGENTS.md",
    "project-management/policies/AUTHORITY.md",
    "project-management/policies/DATA.md",
    "project-management/policies/EVIDENCE.md",
    "project-management/policies/INCIDENTS.md",
    "project-management/policies/INFRASTRUCTURE.md",
    "project-management/policies/LANGSMITH.md",
    "project-management/policies/OBJECTIVES.md",
    "project-management/policies/QUALITY.md",
    "project-management/policies/RELEASES.md",
    "project-management/policies/SECURITY.md",
    "project-management/policies/TASKS.md",
    "project-management/templates/AGENT_HANDOVER.md",
    "project-management/templates/AGENT_PROPOSAL.md",
    "project-management/templates/ASSIGNMENT.md",
    "project-management/templates/CHANGE_REQUEST.md",
    "project-management/templates/COMPLETION_REPORT.md",
    "project-management/templates/EVALUATION_CASE.md",
    "project-management/templates/EVALUATION_SUITE.md",
    "project-management/templates/GOVERNANCE_CERTIFICATION.md",
    "project-management/templates/LANGSMITH_TRACE_REVIEW.md",
    "project-management/templates/RELEASE_MANIFEST.md",
    "project-management/templates/REVIEW_FINDING.md",
    "project-management/templates/TASK_CONTRACT.md",
    "project-management/templates/TRAJECTORY_EXPECTATION.md",
    "project-management/bootstrap/AGENT_CAPABILITY_PLAN.md",
    "project-management/bootstrap/PM_BOOTSTRAP_STATE.md",
  ];
  assert.equal(retiredGeneratedPaths.length,42);
  for (const relativePath of retiredGeneratedPaths) {
    const retiredPath=path.join(coreProject,...relativePath.split("/"));
    fs.mkdirSync(path.dirname(retiredPath),{recursive:true});
    fs.writeFileSync(retiredPath,`retired generated asset: ${relativePath}\n`,"utf8");
    const stateBefore=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
    const residueBefore=fs.readFileSync(retiredPath,"utf8");
    const residueOverlay=runCli([
      "Core Overlay Project",
      "--slug",coreSlug,
      "--dir",coreProject,
      "--no-git",
      "--force",
    ]);
    assertRejected(
      residueOverlay,
      /Refusing --force.*retired governance.*manual v2 migration guide/i,
      `same-profile retired residue ${relativePath}`,
    );
    assert.match(
      residueOverlay.stderr,
      new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")),
      `retired residue refusal did not identify ${relativePath}`,
    );
    assert.equal(
      fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
      stateBefore,
      `retired residue ${relativePath} rewrote project state`,
    );
    assert.equal(
      fs.readFileSync(retiredPath,"utf8"),
      residueBefore,
      `retired residue ${relativePath} was mutated before refusal`,
    );
    fs.rmSync(retiredPath);
  }

  const retiredContentFixtures=[
    {
      relativePath:".env.example",
      contents:"LANGSMITH_PROJECT=legacy-project\n# Configure real secrets in your secret store / GitHub secrets.\n",
    },
    {
      relativePath:".claude/settings.local.json.example",
      contents:JSON.stringify({
        env:{
          TRACE_TO_LANGSMITH:"true",
          CC_LANGSMITH_API_KEY:"${LANGSMITH_API_KEY_FROM_SECRET_STORE}",
          CC_LANGSMITH_PROJECT:"Klinik360",
          CC_LANGSMITH_METADATA:"{}",
        },
      },null,2)+"\n",
    },
  ];
  for (const fixture of retiredContentFixtures) {
    const retiredPath=path.join(coreProject,...fixture.relativePath.split("/"));
    fs.mkdirSync(path.dirname(retiredPath),{recursive:true});
    fs.writeFileSync(retiredPath,fixture.contents,"utf8");
    const stateBefore=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
    const residueOverlay=runCli([
      "Core Overlay Project",
      "--slug",coreSlug,
      "--dir",coreProject,
      "--no-git",
      "--force",
    ]);
    assertRejected(
      residueOverlay,
      /Refusing --force.*retired governance.*manual v2 migration guide/i,
      `same-profile retired residue ${fixture.relativePath}`,
    );
    assert.match(residueOverlay.stderr,new RegExp(fixture.relativePath.replaceAll(".","\\.")));
    assert.equal(
      fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
      stateBefore,
      `retired residue ${fixture.relativePath} rewrote project state`,
    );
    assert.equal(fs.readFileSync(retiredPath,"utf8"),fixture.contents);
    fs.rmSync(retiredPath);
  }

  const cleanV2State=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
  const retiredStateCases=[
    ["governance_version",state => { state.governance_version="1.6.0"; }],
    ["langsmith",state => { state.langsmith={project:"legacy"}; }],
    ["governance.trusted_evaluator_check",state => {
      state.governance.trusted_evaluator_check="governance-certification";
    }],
    ["governance.assurance",state => { state.governance.assurance=true; }],
    ["governance.profiles.assurance",state => {
      state.governance.profiles.assurance=true;
    }],
    ["bootstrap_state.langsmith",state => {
      state.bootstrap_state.langsmith="PENDING";
    }],
    ["bootstrap_state.trusted_evaluator",state => {
      state.bootstrap_state.trusted_evaluator="PENDING";
    }],
  ];
  for (const [label,mutate] of retiredStateCases) {
    const state=JSON.parse(cleanV2State);
    mutate(state);
    const legacyHybridState=JSON.stringify(state,null,2)+"\n";
    fs.writeFileSync(path.join(coreProject,"project.json"),legacyHybridState,"utf8");
    const stateOverlay=runCli([
      "Core Overlay Project",
      "--slug",coreSlug,
      "--dir",coreProject,
      "--no-git",
      "--force",
    ]);
    assertRejected(
      stateOverlay,
      /Refusing --force.*legacy governance state.*manual v2 migration guide/i,
      `same-profile retired state ${label}`,
    );
    assert.equal(
      fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
      legacyHybridState,
      `retired state ${label} was mutated before refusal`,
    );
    fs.writeFileSync(path.join(coreProject,"project.json"),cleanV2State,"utf8");
  }

  const briefContextPath=path.join(
    coreProject,
    "project-management","bootstrap","PROJECT_BRIEF.json",
  );
  const cleanBriefContext=fs.readFileSync(briefContextPath,"utf8");
  const legacyBriefContext=JSON.parse(cleanBriefContext);
  legacyBriefContext.langsmith={project:"legacy-generated-evaluation-project"};
  const legacyBriefContextText=JSON.stringify(legacyBriefContext,null,2)+"\n";
  fs.writeFileSync(briefContextPath,legacyBriefContextText,"utf8");
  const contextStateBefore=fs.readFileSync(path.join(coreProject,"project.json"),"utf8");
  const legacyContextOverlay=runCli([
    "Core Overlay Project",
    "--slug",coreSlug,
    "--dir",coreProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    legacyContextOverlay,
    /Refusing --force.*PROJECT_BRIEF\.json.*manual v2 migration guide/i,
    "same-profile retired Project Brief context",
  );
  assert.equal(
    fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
    contextStateBefore,
    "retired Project Brief context rewrote project state",
  );
  assert.equal(
    fs.readFileSync(briefContextPath,"utf8"),
    legacyBriefContextText,
    "retired Project Brief context was mutated before refusal",
  );
  fs.writeFileSync(briefContextPath,cleanBriefContext,"utf8");

  const ordinaryEnv=path.join(coreProject,".env.example");
  const ordinaryClaude=path.join(coreProject,".claude","settings.local.json.example");
  fs.mkdirSync(path.dirname(ordinaryClaude),{recursive:true});
  fs.writeFileSync(ordinaryEnv,"APP_MODE=development\n","utf8");
  fs.writeFileSync(
    ordinaryClaude,
    JSON.stringify({env:{APP_MODE:"development"}},null,2)+"\n",
    "utf8",
  );

  const sameProfile=runCli([
    "Core Overlay Project",
    "--slug",coreSlug,
    "--dir",coreProject,
    "--no-git",
    "--force",
  ]);
  assertSuccess(sameProfile,"same-profile Core force refresh");
  const refreshedState=JSON.parse(
    fs.readFileSync(path.join(coreProject,"project.json"),"utf8"),
  );
  assert.deepEqual(refreshedState.governance.profiles,{core:true,delivery:false});
  assert.equal(fs.readFileSync(ordinaryEnv,"utf8"),"APP_MODE=development\n");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(ordinaryClaude,"utf8")),
    {env:{APP_MODE:"development"}},
  );
  fs.rmSync(ordinaryEnv);
  fs.rmSync(ordinaryClaude);

  const outsideRuntimeTarget=path.join(tmp,"outside-runtime-target.md");
  fs.writeFileSync(outsideRuntimeTarget,"outside sentinel\n","utf8");
  const generatedReadme=path.join(coreProject,"README.md");
  fs.rmSync(generatedReadme);
  fs.symlinkSync(outsideRuntimeTarget,generatedReadme);
  const runtimeSymlinkOverlay=runCli([
    "Core Overlay Project",
    "--slug",coreSlug,
    "--dir",coreProject,
    "--no-git",
    "--force",
  ]);
  assertRejected(
    runtimeSymlinkOverlay,
    /Refusing --force.*symbolic link.*README\.md/i,
    "same-profile runtime-template symlink overlay",
  );
  assert.equal(
    fs.readFileSync(outsideRuntimeTarget,"utf8"),
    "outside sentinel\n",
    "same-profile force overlay wrote through a runtime-template symlink",
  );

  console.log("Force overlay safety test: PASS");
} finally {
  fs.rmSync(tmp,{recursive:true,force:true});
}
