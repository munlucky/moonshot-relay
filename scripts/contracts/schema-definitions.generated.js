// Generated from src/contracts/schema-definitions.generated.ts. Edit the source and run npm run build.
export const KERNEL_SCHEMA_DEFINITIONS = [
    {
        "id": "kernel.applicable-knowledge-slice",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelApplicableKnowledgeSlice\",\"type\":\"object\",\"required\":[\"architectureDecisions\",\"architectureRequirements\",\"domainTerms\",\"componentBoundaries\",\"ontologyConstraints\",\"tacitPractices\",\"provenance\"],\"properties\":{\"architectureDecisions\":{\"type\":\"array\"},\"architectureRequirements\":{\"type\":\"array\"},\"domainTerms\":{\"type\":\"array\"},\"componentBoundaries\":{\"type\":\"array\"},\"apiDataContracts\":{\"type\":\"array\"},\"graphRelations\":{\"type\":\"array\"},\"ontologyConstraints\":{\"type\":\"array\"},\"tacitPractices\":{\"type\":\"array\"},\"knownFailurePatterns\":{\"type\":\"array\"},\"requiredVerifications\":{\"type\":\"array\"},\"unresolvedConflicts\":{\"type\":\"array\"},\"provenance\":{\"type\":\"array\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.attempt-provenance",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.attempt-provenance.schema.json\",\"title\":\"Kernel canonical work-attempt provenance\",\"description\":\"The durable lineage for one run step attempt. Legacy-unattributed rows are retained without guessed provenance.\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"runId\",\"stepId\",\"provenanceKind\",\"status\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"attemptId\":{\"type\":[\"string\",\"null\"],\"pattern\":\"^attempt-[a-f0-9-]{8,96}$\"},\"runId\":{\"type\":\"string\",\"minLength\":1},\"stepId\":{\"type\":\"string\",\"minLength\":1},\"bindingId\":{\"type\":[\"string\",\"null\"]},\"capsuleId\":{\"type\":[\"string\",\"null\"]},\"capsuleDigest\":{\"type\":[\"string\",\"null\"]},\"admissionId\":{\"type\":[\"string\",\"null\"]},\"parentAttemptId\":{\"type\":[\"string\",\"null\"]},\"provenanceKind\":{\"enum\":[\"routed\",\"owner-session\",\"kernel-owned\",\"legacy-unattributed\"]},\"planRevision\":{\"type\":[\"integer\",\"null\"],\"minimum\":1},\"mutationRevision\":{\"type\":[\"integer\",\"null\"],\"minimum\":0},\"retryReason\":{\"type\":[\"string\",\"null\"]},\"failureCategory\":{\"type\":[\"string\",\"null\"]},\"status\":{\"enum\":[\"started\",\"passed\",\"failed\",\"interrupted\",\"superseded\",\"cancelled\"]}},\"allOf\":[{\"if\":{\"properties\":{\"provenanceKind\":{\"const\":\"legacy-unattributed\"}}},\"then\":{\"properties\":{\"attemptId\":{\"type\":\"null\"},\"planRevision\":{\"type\":\"null\"},\"mutationRevision\":{\"type\":\"null\"}}},\"else\":{\"required\":[\"attemptId\",\"planRevision\",\"mutationRevision\"],\"properties\":{\"attemptId\":{\"type\":\"string\",\"pattern\":\"^attempt-[a-f0-9-]{8,96}$\"},\"planRevision\":{\"type\":\"integer\",\"minimum\":1},\"mutationRevision\":{\"type\":\"integer\",\"minimum\":0}}}}]}"
    },
    {
        "id": "kernel.codebase-index-manifest",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.codebase-index-manifest.schema.json\",\"type\":\"object\",\"required\":[\"schemaVersion\",\"projectId\",\"sourceCommit\",\"sourceTreeDigest\",\"graphDigest\",\"skillVersion\",\"generatedAt\",\"status\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"projectId\":{\"type\":\"string\"},\"sourceCommit\":{\"type\":\"string\"},\"sourceTreeDigest\":{\"type\":\"string\"},\"graphDigest\":{\"type\":\"string\"},\"skillVersion\":{\"type\":\"string\"},\"generatedAt\":{\"type\":\"string\"},\"status\":{\"enum\":[\"fresh\",\"stale\",\"degraded\",\"cache_hit\"]}},\"additionalProperties\":false}"
    },
    {
        "id": "kernel.context-receipt",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.context-receipt.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"receiptId\",\"stage\",\"policyRevision\",\"policyDigest\",\"tokenEstimate\",\"included\",\"omitted\",\"digest\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"receiptId\":{\"type\":\"string\"},\"stage\":{\"enum\":[\"FRAME\",\"SHAPE\",\"SLICE\",\"SCHEDULE\",\"EXECUTE\",\"PROVE\",\"CLOSE\"]},\"policyRevision\":{\"type\":\"string\"},\"policyDigest\":{\"type\":[\"string\",\"null\"]},\"tokenEstimate\":{\"type\":\"integer\",\"minimum\":0},\"included\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"id\",\"layer\",\"revision\",\"contentDigest\"],\"properties\":{\"id\":{\"type\":\"string\"},\"layer\":{\"type\":\"string\"},\"revision\":{\"type\":\"string\"},\"contentDigest\":{\"type\":\"string\"},\"sourceRef\":{\"type\":\"string\"},\"sourceDigest\":{\"type\":\"string\",\"pattern\":\"^[a-f0-9]{64}$\"},\"trust\":{\"type\":\"string\"},\"truncated\":{\"type\":\"boolean\"}}}},\"omitted\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"id\",\"reason\"],\"properties\":{\"id\":{\"type\":\"string\"},\"reason\":{\"type\":\"string\"}}}},\"digest\":{\"type\":\"string\",\"pattern\":\"^[a-f0-9]{64}$\"}}}"
    },
    {
        "id": "kernel.durable-state",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"authority\":{\"type\":\"object\",\"properties\":{\"source\":{\"const\":\"sqlite\"},\"durable\":{\"const\":true}},\"required\":[\"source\",\"durable\"],\"additionalProperties\":false},\"project\":{\"type\":\"object\",\"properties\":{\"projectId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"workspaceId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"worktreeId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"projectId\",\"workspaceId\",\"worktreeId\"],\"additionalProperties\":false},\"task\":{\"type\":\"object\",\"properties\":{\"runId\":{\"type\":\"string\"},\"objective\":{\"type\":\"string\"},\"taskClass\":{\"type\":\"string\"},\"contractRevision\":{\"type\":\"number\"},\"acceptanceCriteria\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"constraints\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"nonGoals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"runId\",\"objective\",\"taskClass\",\"contractRevision\",\"acceptanceCriteria\",\"constraints\",\"nonGoals\"],\"additionalProperties\":false},\"work\":{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"state\":{\"type\":\"string\"},\"planRevision\":{\"type\":\"number\"},\"mutationRevision\":{\"type\":\"number\"},\"cursor\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"planRevision\":{\"type\":\"number\"},\"currentStepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"currentSequence\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"stepCount\":{\"type\":\"number\"}},\"required\":[\"planRevision\",\"currentStepId\",\"currentSequence\",\"stepCount\"],\"additionalProperties\":false}]},\"currentWorkUnit\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"stepId\":{\"type\":\"string\"},\"sequence\":{\"type\":\"number\"},\"planRevision\":{\"type\":\"number\"},\"objective\":{\"type\":\"string\"},\"state\":{\"type\":\"string\"},\"synthetic\":{\"type\":\"boolean\"},\"acceptanceIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"obligationIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"allowedPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"forbiddenPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"stepId\",\"sequence\",\"planRevision\",\"objective\",\"state\",\"synthetic\",\"acceptanceIds\",\"obligationIds\",\"allowedPaths\",\"forbiddenPaths\"],\"additionalProperties\":false}]},\"progress\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"completedWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"completedCurrentPlanWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"remainingWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"completedCount\":{\"type\":\"number\"},\"completedCurrentPlanCount\":{\"type\":\"number\"},\"remainingCount\":{\"type\":\"number\"}},\"required\":[\"completedWorkUnitIds\",\"completedCurrentPlanWorkUnitIds\",\"remainingWorkUnitIds\",\"completedCount\",\"completedCurrentPlanCount\",\"remainingCount\"],\"additionalProperties\":false}]},\"resume\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"action\":{\"anyOf\":[{\"const\":\"none\"},{\"const\":\"continue-current-work-unit\"},{\"const\":\"continue-work\"},{\"const\":\"rebuild-work-cursor\"}]},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"status\",\"action\",\"stepId\"],\"additionalProperties\":false}]}},\"required\":[\"status\",\"state\",\"planRevision\",\"mutationRevision\",\"cursor\",\"currentWorkUnit\",\"progress\",\"resume\"],\"additionalProperties\":false},\"execution\":{\"type\":\"object\",\"properties\":{\"executionClass\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"planning\"},{\"const\":\"complex_implementation\"},{\"const\":\"review\"},{\"const\":\"standard\"}]}},\"required\":[\"executionClass\"],\"additionalProperties\":false},\"evidence\":{\"type\":\"object\",\"properties\":{\"requiredObligations\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"obligationId\":{\"type\":\"string\"},\"evidenceClass\":{\"type\":\"string\"},\"acceptanceIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"obligationId\",\"evidenceClass\",\"acceptanceIds\"],\"additionalProperties\":false}},\"verifications\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"obligationId\":{\"type\":\"string\"},\"status\":{\"type\":\"string\"},\"evidenceDigest\":{},\"acceptanceCoverage\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"verifiedMutationRevision\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]}},\"required\":[\"obligationId\",\"status\",\"evidenceDigest\",\"acceptanceCoverage\",\"verifiedMutationRevision\"],\"additionalProperties\":false}}},\"required\":[\"requiredObligations\",\"verifications\"],\"additionalProperties\":false},\"completion\":{\"type\":\"object\",\"properties\":{\"decision\":{},\"overall\":{},\"finalizationStatus\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"decision\",\"overall\",\"finalizationStatus\"],\"additionalProperties\":false},\"knowledge\":{\"type\":\"object\",\"properties\":{\"revisionStart\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"},{\"type\":\"number\"}]},\"revisionClose\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"},{\"type\":\"number\"}]},\"status\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"revisionStart\",\"revisionClose\",\"status\"],\"additionalProperties\":false}},\"required\":[\"schemaVersion\",\"authority\",\"project\",\"task\",\"work\",\"execution\",\"evidence\",\"completion\",\"knowledge\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.durable-state.schema.json\",\"title\":\"KernelDurableState\"}"
    },
    {
        "id": "kernel.eval-case",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.eval-case.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"id\",\"taskClass\",\"riskTier\",\"objective\",\"expectedRoute\",\"sourceKind\",\"requiredEvidence\"],\"properties\":{\"id\":{\"pattern\":\"^KRN-EVAL-[0-9]{3}$\"},\"taskClass\":{\"enum\":[\"analysis\",\"bug\",\"feature\",\"refactor\",\"ui\",\"long-running\"]},\"riskTier\":{\"enum\":[\"T0\",\"T1\",\"T2\",\"T3\"]},\"objective\":{\"type\":\"string\",\"minLength\":8},\"expectedRoute\":{\"type\":\"array\",\"minItems\":2,\"items\":{\"enum\":[\"FRAME\",\"SHAPE\",\"SLICE\",\"SCHEDULE\",\"EXECUTE\",\"PROVE\",\"CLOSE\"]}},\"sourceKind\":{\"enum\":[\"historical\",\"synthetic\"]},\"requiredEvidence\":{\"type\":\"array\",\"minItems\":1,\"items\":{\"type\":\"string\"}}}}"
    },
    {
        "id": "kernel.execution-capsule",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"capsuleId\":{\"type\":\"string\"},\"provenance\":{\"type\":\"object\",\"properties\":{\"capsuleDigest\":{\"type\":\"string\"},\"workspaceIdentity\":{\"type\":\"string\"},\"sourceIdentity\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"taskContractDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"knowledgeContextDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"routeDecisionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"createdByVersion\":{\"type\":\"string\"},\"migrationOrigin\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"capsuleDigest\",\"workspaceIdentity\",\"sourceIdentity\",\"taskContractDigest\",\"knowledgeContextDigest\",\"routeDecisionId\",\"createdByVersion\",\"migrationOrigin\"],\"additionalProperties\":false},\"createdAt\":{\"type\":\"string\"},\"schemaVersion\":{\"const\":1},\"runId\":{\"type\":\"string\"},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"role\":{\"enum\":[\"implementer\",\"reviewer\",\"planner\",\"researcher\"]},\"riskTier\":{\"type\":\"string\"},\"planRevision\":{\"type\":\"number\"},\"mutationRevision\":{\"type\":\"number\"},\"objective\":{\"type\":\"string\"},\"acceptance\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"statement\":{\"type\":\"string\"},\"obligationIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"id\",\"statement\",\"obligationIds\"],\"additionalProperties\":false}},\"constraints\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"nonGoals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"workUnit\":{\"type\":\"object\",\"properties\":{\"objective\":{\"type\":\"string\"},\"dependencies\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"allowedPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"forbiddenPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"expectedOutputs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"objective\",\"dependencies\",\"allowedPaths\",\"forbiddenPaths\",\"expectedOutputs\"],\"additionalProperties\":false},\"repositoryContext\":{\"type\":\"object\",\"properties\":{\"projectMode\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"entrypoints\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"relevantFiles\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"reason\":{\"type\":\"string\"},\"digest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"path\",\"reason\",\"digest\"],\"additionalProperties\":false}},\"relevantSymbols\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"symbol\":{\"type\":\"string\"},\"path\":{\"type\":\"string\"}},\"required\":[\"symbol\",\"path\"],\"additionalProperties\":false}},\"manifests\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"knownCommands\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"architectureRecords\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"recordId\":{\"type\":\"string\"},\"summary\":{\"type\":\"string\"}},\"required\":[\"recordId\",\"summary\"],\"additionalProperties\":false}},\"knowledgeRecords\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"recordId\":{\"type\":\"string\"},\"summary\":{\"type\":\"string\"},\"revision\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]}},\"required\":[\"recordId\",\"summary\",\"revision\"],\"additionalProperties\":false}},\"walkingSkeleton\":{\"type\":[\"object\",\"null\"],\"additionalProperties\":true},\"baseline\":{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"digest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"knownFailures\":{\"type\":\"array\",\"items\":{}}},\"required\":[\"status\",\"digest\",\"knownFailures\"],\"additionalProperties\":false}},\"required\":[\"projectMode\",\"entrypoints\",\"relevantFiles\",\"relevantSymbols\",\"manifests\",\"knownCommands\",\"architectureRecords\",\"knowledgeRecords\",\"walkingSkeleton\",\"baseline\"],\"additionalProperties\":false},\"verification\":{\"type\":\"object\",\"properties\":{\"obligations\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"obligationId\":{\"type\":\"string\"},\"evidenceClass\":{\"type\":\"string\"},\"allowedCommandRefs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"acceptanceIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"obligationId\",\"evidenceClass\",\"allowedCommandRefs\",\"acceptanceIds\"],\"additionalProperties\":false}}},\"required\":[\"obligations\"],\"additionalProperties\":false},\"permissions\":{\"type\":\"object\",\"properties\":{\"filesystem\":{\"enum\":[\"read_only\",\"plan_write\",\"workspace_write\"]},\"network\":{\"type\":\"string\"},\"canDelegate\":{\"type\":\"boolean\"},\"canCommit\":{\"type\":\"boolean\"}},\"required\":[\"filesystem\",\"network\",\"canDelegate\",\"canCommit\"],\"additionalProperties\":false},\"budget\":{\"type\":\"object\",\"properties\":{\"reductions\":{\"type\":\"array\",\"items\":{}},\"serializedBytes\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"withinBudget\":{\"type\":\"boolean\"}},\"required\":[\"reductions\",\"serializedBytes\",\"withinBudget\"],\"additionalProperties\":false}},\"required\":[\"capsuleId\",\"provenance\",\"createdAt\",\"schemaVersion\",\"runId\",\"stepId\",\"role\",\"riskTier\",\"planRevision\",\"mutationRevision\",\"objective\",\"acceptance\",\"constraints\",\"nonGoals\",\"workUnit\",\"repositoryContext\",\"verification\",\"permissions\",\"budget\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.execution-capsule.schema.json\",\"title\":\"Kernel execution capsule\"}"
    },
    {
        "id": "kernel.git-closeout-receipt",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelGitCloseoutReceipt\",\"type\":\"object\",\"required\":[\"schemaVersion\",\"runId\",\"projectId\",\"requestedMode\",\"status\",\"digest\"],\"properties\":{\"schemaVersion\":{\"type\":\"integer\",\"const\":1},\"runId\":{\"type\":\"string\"},\"projectId\":{\"type\":\"string\"},\"requestedMode\":{\"type\":\"string\"},\"knowledgeCommitReceiptRef\":{\"type\":\"string\"},\"selectedPaths\":{\"type\":\"array\"},\"excludedPaths\":{\"type\":\"array\"},\"commitSha\":{\"type\":\"string\"},\"branch\":{\"type\":\"string\"},\"remote\":{\"type\":\"string\"},\"pushStatus\":{\"type\":\"string\",\"enum\":[\"skipped\",\"completed\",\"failed\"]},\"remoteHeadSha\":{\"type\":\"string\"},\"parity\":{\"type\":\"string\",\"enum\":[\"matched\",\"mismatched\",\"not_requested\"]},\"approvalReceipt\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"completed\",\"partial\",\"failed\",\"skipped\"]},\"digest\":{\"type\":\"string\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.git-closeout-request",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelGitCloseoutRequest\",\"type\":\"object\",\"required\":[\"requested\",\"mode\",\"approvedBy\",\"approvalReceipt\"],\"properties\":{\"requested\":{\"type\":\"boolean\"},\"mode\":{\"type\":\"string\",\"enum\":[\"commit\",\"commit_and_push\"]},\"approvedBy\":{\"type\":\"string\"},\"approvalReceipt\":{\"type\":\"string\"},\"message\":{\"type\":\"string\",\"maxLength\":12000,\"description\":\"Optional commit subject and body. The Kernel appends task context to the requested message.\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-candidate",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelKnowledgeCandidate\",\"type\":\"object\",\"required\":[\"candidateId\",\"runId\",\"projectId\",\"proposedType\",\"statement\",\"status\"],\"properties\":{\"candidateId\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"projectId\":{\"type\":\"string\"},\"proposedType\":{\"type\":\"string\",\"enum\":[\"policy_anchor\",\"semantic_fact\",\"kg_relation\",\"ontology_constraint\",\"episodic_observation\"]},\"statement\":{\"type\":\"string\"},\"scope\":{\"type\":\"array\"},\"relatedFiles\":{\"type\":\"array\"},\"sourceRefs\":{\"type\":\"array\"},\"evidenceRefs\":{\"type\":\"array\"},\"confidence\":{\"type\":\"number\",\"minimum\":0,\"maximum\":1},\"status\":{\"type\":\"string\",\"enum\":[\"observed\",\"staged\",\"verified\",\"rejected\",\"committed\",\"superseded\",\"archived\"]},\"supersedes\":{\"type\":\"array\"},\"rejectionReasons\":{\"type\":\"array\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-commit-receipt",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"sourceIdentity\":{\"type\":\"string\"},\"mutationRevision\":{\"type\":\"number\"},\"completionDecisionRef\":{\"type\":\"string\"},\"acceptedCandidates\":{\"type\":\"array\",\"items\":{}},\"rejectedCandidates\":{\"type\":\"array\",\"items\":{}},\"supersededRecords\":{\"type\":\"array\",\"items\":{}},\"evidenceRefs\":{\"type\":\"array\",\"items\":{}},\"filesWritten\":{\"type\":\"array\",\"items\":{}},\"projectionStatus\":{\"type\":\"string\"},\"status\":{\"type\":\"string\"},\"digest\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"projectId\":{\"type\":\"string\"},\"revisionBefore\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"number\"}]},\"revisionAfter\":{\"anyOf\":[{\"type\":\"string\"},{\"type\":\"number\"}]}},\"required\":[\"schemaVersion\",\"sourceIdentity\",\"mutationRevision\",\"completionDecisionRef\",\"acceptedCandidates\",\"rejectedCandidates\",\"supersededRecords\",\"evidenceRefs\",\"filesWritten\",\"projectionStatus\",\"status\",\"digest\",\"runId\",\"projectId\",\"revisionBefore\",\"revisionAfter\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.knowledge-commit-receipt.schema.json\",\"title\":\"KernelKnowledgeCommitReceipt\"}"
    },
    {
        "id": "kernel.knowledge-contract",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelKnowledgeContract\",\"type\":\"object\",\"required\":[\"schemaVersion\",\"projectId\",\"knowledgeRevision\",\"status\",\"strictness\",\"stage\"],\"properties\":{\"schemaVersion\":{\"type\":\"integer\",\"const\":1},\"projectId\":{\"type\":\"string\"},\"knowledgeRevision\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"ready\",\"stale\",\"degraded_read\",\"degraded_write\",\"not_configured\"]},\"strictness\":{\"type\":\"string\",\"enum\":[\"advisory\",\"required\"]},\"stage\":{\"type\":\"string\",\"enum\":[\"FRAME\",\"SHAPE\",\"SLICE\",\"SCHEDULE\",\"EXECUTE\",\"PROVE\",\"CLOSE\"]},\"policyAnchors\":{\"type\":\"array\"},\"semanticFacts\":{\"type\":\"array\"},\"graphSynopsis\":{\"type\":\"array\"},\"ontologyConstraints\":{\"type\":\"array\"},\"staleOrUnavailable\":{\"type\":\"array\"},\"omittedByPolicy\":{\"type\":\"array\"},\"promptBlock\":{\"type\":\"string\"},\"contextPackRef\":{\"type\":\"string\"},\"digest\":{\"type\":\"string\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-import-receipt",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.knowledge-import-receipt.schema.json\",\"type\":\"object\",\"required\":[\"schemaVersion\",\"importId\",\"projectId\",\"authorityType\",\"sourceDigest\",\"candidateCount\",\"acceptedCount\",\"rejectedCount\",\"knowledgeRevisionBefore\",\"knowledgeRevisionAfter\",\"approvalRef\",\"status\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"importId\":{\"type\":\"string\"},\"projectId\":{\"type\":\"string\"},\"authorityType\":{\"const\":\"user_approved_import\"},\"sourceType\":{\"type\":\"string\"},\"sourceIdentityDigest\":{\"type\":\"string\"},\"sourceDigest\":{\"type\":\"string\"},\"candidateCount\":{\"type\":\"integer\",\"minimum\":0},\"acceptedCount\":{\"type\":\"integer\",\"minimum\":0},\"rejectedCount\":{\"type\":\"integer\",\"minimum\":0},\"supersededCount\":{\"type\":\"integer\",\"minimum\":0},\"knowledgeRevisionBefore\":{\"type\":\"integer\",\"minimum\":0},\"knowledgeRevisionAfter\":{\"type\":\"integer\",\"minimum\":0},\"approvalRef\":{\"type\":\"string\",\"minLength\":1},\"status\":{\"type\":\"string\",\"enum\":[\"committed\",\"partial\",\"no_op\"]}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-import",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.knowledge-import.schema.json\",\"type\":\"object\",\"required\":[\"importId\",\"projectId\",\"sourceType\",\"sourceIdentity\",\"sourceDigest\",\"status\",\"candidateCount\",\"acceptedCount\",\"rejectedCount\",\"createdAt\"],\"properties\":{\"importId\":{\"type\":\"string\",\"minLength\":1},\"projectId\":{\"type\":\"string\",\"minLength\":1},\"sourceType\":{\"type\":\"string\",\"enum\":[\"kernel_run\",\"codex_session\",\"claude_session\",\"provider_session\",\"codebase_index\",\"git_commit\",\"pull_request\",\"manual_statement\"]},\"sourceIdentity\":{\"type\":\"string\",\"minLength\":1},\"sourceDigest\":{\"type\":\"string\",\"minLength\":1},\"sourceSnapshotRef\":{\"type\":[\"string\",\"null\"]},\"status\":{\"type\":\"string\",\"enum\":[\"discovered\",\"analyzed\",\"awaiting_review\",\"approved\",\"committed\",\"partial\",\"rejected\",\"failed\",\"no_op\"]},\"candidateCount\":{\"type\":\"integer\",\"minimum\":0},\"acceptedCount\":{\"type\":\"integer\",\"minimum\":0},\"rejectedCount\":{\"type\":\"integer\",\"minimum\":0},\"approvalRef\":{\"type\":[\"string\",\"null\"]},\"revisionBefore\":{\"type\":[\"integer\",\"null\"]},\"revisionAfter\":{\"type\":[\"integer\",\"null\"]},\"createdAt\":{\"type\":\"string\"},\"completedAt\":{\"type\":[\"string\",\"null\"]}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-record",
        "draft": "http://json-schema.org/draft-07/schema#",
        "schemaJson": "{\"$schema\":\"http://json-schema.org/draft-07/schema#\",\"title\":\"KernelKnowledgeRecord\",\"type\":\"object\",\"required\":[\"id\",\"projectId\",\"type\",\"statement\",\"status\",\"trustTier\",\"createdAt\"],\"properties\":{\"id\":{\"type\":\"string\",\"pattern\":\"^[a-zA-Z0-9._-]{1,128}$\"},\"projectId\":{\"type\":\"string\"},\"type\":{\"type\":\"string\",\"enum\":[\"policy_anchor\",\"semantic_fact\",\"architecture_decision\",\"domain_term\",\"component_boundary\",\"api_contract\",\"kg_relation\",\"ontology_constraint\",\"episodic_observation\",\"known_failure_pattern\",\"required_verification\",\"provenance_event\",\"knowledge_candidate\"]},\"statement\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"observed\",\"staged\",\"verified\",\"rejected\",\"committed\",\"superseded\",\"archived\",\"quarantined\"]},\"trustTier\":{\"type\":\"string\",\"enum\":[\"authoritative\",\"verified\",\"derived\",\"quarantined\",\"degraded\"]},\"createdAt\":{\"type\":\"string\"},\"updatedAt\":{\"type\":\"string\"},\"sourceRef\":{\"type\":\"string\"},\"evidence\":{},\"provenance\":{\"type\":\"array\",\"items\":{\"type\":\"object\"}},\"supersedes\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.knowledge-review-result",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"status\":{\"anyOf\":[{\"const\":\"failed\"},{\"const\":\"no_candidates\"},{\"const\":\"passed\"},{\"const\":\"needs_approval\"},{\"const\":\"pending_verification\"}]},\"verifiedCandidates\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"candidateId\":{\"anyOf\":[{\"type\":\"string\"}]},\"projectId\":{\"anyOf\":[{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"rejectionReasons\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceBinding\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]}},\"required\":[],\"additionalProperties\":{}}]},\"sourceKind\":{\"anyOf\":[{\"type\":\"string\"}]},\"sourceDigest\":{\"anyOf\":[{\"type\":\"string\"}]},\"obligationId\":{\"anyOf\":[{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"rejectedCandidates\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"candidateId\":{\"anyOf\":[{\"type\":\"string\"}]},\"projectId\":{\"anyOf\":[{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"rejectionReasons\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceBinding\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]}},\"required\":[],\"additionalProperties\":{}}]},\"sourceKind\":{\"anyOf\":[{\"type\":\"string\"}]},\"sourceDigest\":{\"anyOf\":[{\"type\":\"string\"}]},\"obligationId\":{\"anyOf\":[{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"needsApprovalCandidates\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"candidateId\":{\"anyOf\":[{\"type\":\"string\"}]},\"projectId\":{\"anyOf\":[{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"rejectionReasons\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceBinding\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]}},\"required\":[],\"additionalProperties\":{}}]},\"sourceKind\":{\"anyOf\":[{\"type\":\"string\"}]},\"sourceDigest\":{\"anyOf\":[{\"type\":\"string\"}]},\"obligationId\":{\"anyOf\":[{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"pendingVerificationCandidates\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"candidateId\":{\"anyOf\":[{\"type\":\"string\"}]},\"projectId\":{\"anyOf\":[{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"rejectionReasons\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceBinding\":{\"anyOf\":[{\"type\":\"object\",\"properties\":{\"acceptanceIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"obligationIds\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"evidenceRefs\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]}},\"required\":[],\"additionalProperties\":{}}]},\"sourceKind\":{\"anyOf\":[{\"type\":\"string\"}]},\"sourceDigest\":{\"anyOf\":[{\"type\":\"string\"}]},\"obligationId\":{\"anyOf\":[{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"candidateReviews\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"candidateId\":{\"anyOf\":[{\"type\":\"string\"}]},\"decision\":{\"type\":\"string\"},\"reason\":{\"anyOf\":[{\"type\":\"string\"}]},\"evidenceRef\":{\"anyOf\":[{\"type\":\"string\"}]}},\"required\":[\"decision\"],\"additionalProperties\":{}}},\"supersessionProposals\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":{}}},\"ontologyViolations\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"anyOf\":[{\"type\":\"string\"}]},\"type\":{\"anyOf\":[{\"type\":\"string\"}]},\"recordType\":{\"anyOf\":[{\"type\":\"string\"}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"pattern\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"severity\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"approvalRequired\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"anyOf\":[{\"type\":\"string\"}]},\"type\":{\"anyOf\":[{\"type\":\"string\"}]},\"recordType\":{\"anyOf\":[{\"type\":\"string\"}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"pattern\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"severity\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"verificationsRequired\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"anyOf\":[{\"type\":\"string\"}]},\"type\":{\"anyOf\":[{\"type\":\"string\"}]},\"recordType\":{\"anyOf\":[{\"type\":\"string\"}]},\"status\":{\"anyOf\":[{\"type\":\"string\"}]},\"scope\":{\"anyOf\":[{\"type\":\"array\",\"items\":{\"type\":\"string\"}}]},\"pattern\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"severity\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"statement\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[],\"additionalProperties\":{}}},\"evidenceCoverage\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"status\",\"verifiedCandidates\",\"rejectedCandidates\",\"needsApprovalCandidates\",\"pendingVerificationCandidates\",\"candidateReviews\",\"supersessionProposals\",\"ontologyViolations\",\"approvalRequired\",\"verificationsRequired\",\"evidenceCoverage\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.knowledge-review-result.schema.json\",\"title\":\"KernelKnowledgeReviewResult\"}"
    },
    {
        "id": "kernel.measurement",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.measurement.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"harnessIdentity\",\"sourceIdentity\",\"taskIdentity\",\"currentWorkspaceIdentity\",\"hardEvidenceCoverage\",\"promptTokenBudget\",\"providerModelIdentity\",\"estimatedStaticTokens\",\"actualInputTokens\",\"actualOutputTokens\",\"successDecision\",\"falseCompletionDecision\",\"retryCount\",\"replanCount\",\"userInterventionCount\",\"wallClockMs\",\"evidenceCoverage\",\"workflowEfficiency\",\"efficiencyTelemetry\",\"contaminationSignals\",\"modelRouting\"],\"properties\":{\"schemaVersion\":{\"const\":2},\"harnessIdentity\":{\"type\":\"string\",\"minLength\":1},\"sourceIdentity\":{\"type\":\"string\",\"minLength\":1},\"taskIdentity\":{\"type\":\"string\",\"minLength\":1},\"currentWorkspaceIdentity\":{\"$ref\":\"#/$defs/measurementValue\"},\"hardEvidenceCoverage\":{\"$ref\":\"#/$defs/measurementValue\"},\"promptTokenBudget\":{\"$ref\":\"#/$defs/measurementValue\"},\"providerModelIdentity\":{\"$ref\":\"#/$defs/measurementValue\"},\"modelRouting\":{\"$ref\":\"#/$defs/measurementValue\"},\"estimatedStaticTokens\":{\"type\":\"integer\",\"minimum\":0},\"actualInputTokens\":{\"$ref\":\"#/$defs/measurementValue\"},\"actualOutputTokens\":{\"$ref\":\"#/$defs/measurementValue\"},\"successDecision\":{\"$ref\":\"#/$defs/measurementValue\"},\"falseCompletionDecision\":{\"$ref\":\"#/$defs/measurementValue\"},\"retryCount\":{\"$ref\":\"#/$defs/measurementValue\"},\"replanCount\":{\"$ref\":\"#/$defs/measurementValue\"},\"userInterventionCount\":{\"$ref\":\"#/$defs/measurementValue\"},\"wallClockMs\":{\"$ref\":\"#/$defs/measurementValue\"},\"evidenceCoverage\":{\"$ref\":\"#/$defs/measurementValue\"},\"workflowEfficiency\":{\"$ref\":\"#/$defs/measurementValue\"},\"efficiencyTelemetry\":{\"$ref\":\"#/$defs/measurementValue\"},\"contaminationSignals\":{\"$ref\":\"#/$defs/measurementValue\"}},\"$defs\":{\"measurementValue\":{\"oneOf\":[{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"status\",\"value\"],\"properties\":{\"status\":{\"const\":\"observed\"},\"value\":{}}},{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"status\",\"reason\"],\"properties\":{\"status\":{\"const\":\"unavailable\"},\"reason\":{\"type\":\"string\",\"minLength\":1}}}]}}}"
    },
    {
        "id": "kernel.model-route",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"decisionId\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"attemptNumber\":{\"type\":\"number\"},\"replanCount\":{\"type\":\"number\"},\"planRevision\":{\"type\":\"number\"},\"obligationId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"actionKind\":{\"enum\":[\"understand\",\"design\",\"plan\",\"implement\",\"debug\",\"review_contract\",\"review_engineering\",\"replan\",\"prove\",\"close\"]},\"role\":{\"enum\":[\"planner\",\"implementer\",\"reviewer\",\"kernel\"]},\"executionClass\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"planning\"},{\"const\":\"complex_implementation\"},{\"const\":\"review\"},{\"const\":\"standard\"}]},\"modelClass\":{\"enum\":[\"kernel\",\"frontier_reasoning\",\"value_coding\"]},\"riskTier\":{\"enum\":[\"T0\",\"T1\",\"T2\",\"T3\"]},\"independentContextRequired\":{\"type\":\"boolean\"},\"workProfile\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"executionClass\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"planning\"},{\"const\":\"complex_implementation\"},{\"const\":\"review\"},{\"const\":\"standard\"}]},\"complexity\":{\"enum\":[\"standard\",\"routine\",\"complex\",\"large-refactor\"]},\"repeatedFailure\":{\"type\":\"boolean\"},\"independentContextRequired\":{\"type\":\"boolean\"},\"parallelizable\":{\"type\":\"boolean\"}},\"required\":[\"executionClass\",\"complexity\",\"repeatedFailure\",\"independentContextRequired\",\"parallelizable\"],\"additionalProperties\":false}]},\"permissions\":{\"enum\":[\"read_only\",\"plan_write\",\"workspace_write\",\"kernel_runtime\"]},\"reasonCodes\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"policyRevision\":{\"type\":\"string\"},\"createdAt\":{\"type\":\"string\"}},\"required\":[\"schemaVersion\",\"decisionId\",\"runId\",\"attemptNumber\",\"replanCount\",\"planRevision\",\"obligationId\",\"actionKind\",\"role\",\"executionClass\",\"modelClass\",\"riskTier\",\"independentContextRequired\",\"workProfile\",\"permissions\",\"reasonCodes\",\"policyRevision\",\"createdAt\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.model-route.schema.json\",\"title\":\"Kernel execution-class route decision\"}"
    },
    {
        "id": "kernel.model-usage",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"receiptId\":{\"type\":\"string\"},\"decisionId\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"hostSurface\":{\"type\":\"string\"},\"actorSessionId\":{\"type\":\"string\"},\"parentSessionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"resolvedModel\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"resolvedEffort\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"requestedModel\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"requestedEffort\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"observedModel\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"observedEffort\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"executionProfileRevision\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"role\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"actionKind\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"workProfile\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"executionClass\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"planning\"},{\"const\":\"complex_implementation\"},{\"const\":\"review\"},{\"const\":\"standard\"}]},\"complexity\":{\"enum\":[\"standard\",\"routine\",\"complex\",\"large-refactor\"]},\"repeatedFailure\":{\"type\":\"boolean\"},\"independentContextRequired\":{\"type\":\"boolean\"},\"parallelizable\":{\"type\":\"boolean\"}},\"required\":[\"executionClass\",\"complexity\",\"repeatedFailure\",\"independentContextRequired\",\"parallelizable\"],\"additionalProperties\":false}]},\"dispatchMechanism\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"enforcementReason\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"fallbackReason\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"attemptId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"bindingId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"capsuleId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"capsuleDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"admissionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"admissionDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"enforcementStatus\":{\"enum\":[\"enforced\",\"fallback\",\"advisory\",\"unsupported\",\"failed\"]},\"resultStatus\":{\"enum\":[\"failed\",\"completed\",\"interrupted\",\"abandoned\"]},\"startedAt\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"finishedAt\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"wallClockMs\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"inputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"cachedInputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"outputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"costMicros\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"provider\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"surface\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"speedMode\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"reasoningContext\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"reasoningMode\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"delegationMode\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"sessionLineageId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"previousResponseIdDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"promptPrefixDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"promptCacheKeyDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"cacheMode\":{\"oneOf\":[{\"type\":\"null\"},{\"enum\":[\"off\",\"shadow\",\"on\"]}]},\"cacheTtl\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"cacheMissReason\":{\"oneOf\":[{\"type\":\"null\"},{\"enum\":[\"cold-prefix\",\"tool-schema-changed\",\"common-prefix-changed\",\"provider-prefix-changed\",\"project-prefix-changed\",\"run-prefix-changed\",\"model-changed\",\"effort-changed\",\"speed-mode-changed\",\"session-reset\",\"provider-unsupported\",\"usage-unreported\",\"unknown\"]}]},\"modelEscalationReason\":{\"oneOf\":[{\"type\":\"null\"},{\"enum\":[\"risk-tier\",\"complexity\",\"repeated-failure\",\"review-policy\",\"user-request\",\"quality-regression\",\"provider-fallback\",\"unknown\"]}]},\"eligiblePrefixTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"uncachedInputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"cacheReadInputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"cacheWriteInputTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"reasoningTokens\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"createdAt\":{\"type\":\"string\"}},\"required\":[\"schemaVersion\",\"receiptId\",\"decisionId\",\"runId\",\"hostSurface\",\"actorSessionId\",\"parentSessionId\",\"resolvedModel\",\"resolvedEffort\",\"requestedModel\",\"requestedEffort\",\"observedModel\",\"observedEffort\",\"role\",\"actionKind\",\"workProfile\",\"dispatchMechanism\",\"enforcementReason\",\"fallbackReason\",\"attemptId\",\"bindingId\",\"capsuleId\",\"capsuleDigest\",\"admissionId\",\"admissionDigest\",\"stepId\",\"enforcementStatus\",\"resultStatus\",\"startedAt\",\"finishedAt\",\"wallClockMs\",\"inputTokens\",\"cachedInputTokens\",\"outputTokens\",\"costMicros\",\"provider\",\"surface\",\"speedMode\",\"reasoningContext\",\"reasoningMode\",\"delegationMode\",\"sessionLineageId\",\"previousResponseIdDigest\",\"promptPrefixDigest\",\"promptCacheKeyDigest\",\"cacheMode\",\"cacheTtl\",\"cacheMissReason\",\"modelEscalationReason\",\"eligiblePrefixTokens\",\"uncachedInputTokens\",\"cacheReadInputTokens\",\"cacheWriteInputTokens\",\"reasoningTokens\",\"createdAt\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.model-usage.schema.json\",\"title\":\"Kernel model usage receipt\"}"
    },
    {
        "id": "kernel.qa-report",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.qa-report.schema.json\",\"type\":\"object\",\"additionalProperties\":true,\"required\":[\"schemaVersion\",\"tier\",\"proofTier\",\"checks\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"tier\":{\"enum\":[\"E1\",\"E2\"]},\"proofTier\":{\"enum\":[\"T1\",\"T2\",\"T3\"]},\"checks\":{\"type\":\"array\"}}}"
    },
    {
        "id": "kernel.release-evidence",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.release-evidence.schema.json\",\"type\":\"object\",\"additionalProperties\":true,\"required\":[\"schemaVersion\",\"tier\",\"acceptanceCoverage\",\"completionDecision\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"tier\":{\"const\":\"E2\"},\"acceptanceCoverage\":{\"type\":\"array\"},\"completionDecision\":{\"enum\":[\"accepted\",\"blocked\"]}}}"
    },
    {
        "id": "kernel.review-capsule",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"capsuleId\":{\"type\":\"string\"},\"provenance\":{\"type\":\"object\",\"properties\":{\"capsuleDigest\":{\"type\":\"string\"},\"workspaceIdentity\":{\"type\":\"string\"},\"sourceIdentity\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"routeDecisionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"createdByVersion\":{\"type\":\"string\"},\"migrationOrigin\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"capsuleDigest\",\"workspaceIdentity\",\"sourceIdentity\",\"routeDecisionId\",\"createdByVersion\",\"migrationOrigin\"],\"additionalProperties\":false},\"createdAt\":{\"type\":\"string\"},\"schemaVersion\":{\"const\":1},\"runId\":{\"type\":\"string\"},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"role\":{\"const\":\"reviewer\"},\"riskTier\":{\"type\":\"string\"},\"planRevision\":{\"type\":\"number\"},\"objective\":{\"type\":\"string\"},\"acceptance\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"statement\":{\"type\":\"string\"},\"obligationIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"id\",\"statement\",\"obligationIds\"],\"additionalProperties\":false}},\"subject\":{\"type\":\"object\",\"properties\":{\"changedPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"diffDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"workspaceIdentity\":{\"type\":\"string\"},\"mutationRevision\":{\"type\":\"number\"}},\"required\":[\"changedPaths\",\"diffDigest\",\"workspaceIdentity\",\"mutationRevision\"],\"additionalProperties\":false},\"verificationEvidence\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"obligationId\":{\"type\":\"string\"},\"status\":{\"type\":\"string\"},\"evidenceDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"command\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"exitCode\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]}},\"required\":[\"obligationId\",\"status\",\"evidenceDigest\",\"command\",\"exitCode\"],\"additionalProperties\":false}},\"implementationReceipt\":{\"type\":\"object\",\"properties\":{\"actorSessionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"attemptId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"capsuleDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"modelClass\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"resolvedModel\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"actorSessionId\",\"attemptId\",\"capsuleDigest\",\"modelClass\",\"resolvedModel\"],\"additionalProperties\":false},\"reviewScope\":{\"type\":\"object\",\"properties\":{\"stage\":{\"enum\":[\"contract\",\"engineering\",\"complexity\"]},\"requiredChecks\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"obligationId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"stage\",\"requiredChecks\",\"obligationId\"],\"additionalProperties\":false},\"permissions\":{\"type\":\"object\",\"properties\":{\"filesystem\":{\"const\":\"read_only\"},\"network\":{\"type\":\"string\"},\"canDelegate\":{\"type\":\"boolean\"},\"canCommit\":{\"type\":\"boolean\"}},\"required\":[\"filesystem\",\"network\",\"canDelegate\",\"canCommit\"],\"additionalProperties\":false}},\"required\":[\"capsuleId\",\"provenance\",\"createdAt\",\"schemaVersion\",\"runId\",\"stepId\",\"role\",\"riskTier\",\"planRevision\",\"objective\",\"acceptance\",\"subject\",\"verificationEvidence\",\"implementationReceipt\",\"reviewScope\",\"permissions\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.review-capsule.schema.json\",\"title\":\"Kernel review capsule\"}"
    },
    {
        "id": "kernel.review-receipt",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"receiptId\":{\"type\":\"string\"},\"runId\":{\"type\":\"string\"},\"obligationId\":{\"type\":\"string\"},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"reviewerBindingId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"implementerAttemptId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"reviewStage\":{\"enum\":[\"contract\",\"engineering\",\"complexity\"]},\"verdict\":{\"enum\":[\"pass\",\"fail\",\"changes-requested\"]},\"findingClass\":{\"enum\":[\"none\",\"minor\",\"important\",\"critical\"]},\"planRevision\":{\"type\":\"number\"},\"reviewer\":{\"type\":\"object\",\"properties\":{\"actorSessionId\":{\"type\":\"string\"},\"usageReceiptId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"routeDecisionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"modelClass\":{\"type\":\"string\"},\"resolvedModel\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"enforcementStatus\":{\"enum\":[\"enforced\",\"fallback\",\"advisory\",\"unsupported\",\"failed\",\"unrouted\",\"operator_approved\"]},\"approvalRefDigest\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"actorSessionId\",\"usageReceiptId\",\"routeDecisionId\",\"modelClass\",\"resolvedModel\",\"enforcementStatus\",\"approvalRefDigest\"],\"additionalProperties\":false},\"implementer\":{\"type\":\"object\",\"properties\":{\"actorSessionId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"usageReceiptId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"actorSessionId\",\"usageReceiptId\"],\"additionalProperties\":false},\"subject\":{\"type\":\"object\",\"properties\":{\"workspaceIdentity\":{\"type\":\"string\"},\"mutationRevision\":{\"type\":\"number\"},\"changedPathsDigest\":{\"type\":\"string\"},\"evidenceDigest\":{\"type\":\"string\"}},\"required\":[\"workspaceIdentity\",\"mutationRevision\",\"changedPathsDigest\",\"evidenceDigest\"],\"additionalProperties\":false},\"acceptanceCoverage\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"findings\":{\"type\":\"array\",\"items\":{}},\"rationale\":{\"type\":\"string\"},\"createdByVersion\":{\"type\":\"string\"},\"migrationOrigin\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"createdAt\":{\"type\":\"string\"},\"digest\":{\"type\":\"string\"}},\"required\":[\"schemaVersion\",\"receiptId\",\"runId\",\"obligationId\",\"stepId\",\"reviewerBindingId\",\"implementerAttemptId\",\"reviewStage\",\"verdict\",\"findingClass\",\"planRevision\",\"reviewer\",\"implementer\",\"subject\",\"acceptanceCoverage\",\"findings\",\"rationale\",\"createdByVersion\",\"migrationOrigin\",\"createdAt\",\"digest\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.review-receipt.schema.json\",\"title\":\"KernelReviewReceipt\"}"
    },
    {
        "id": "kernel.route-admission",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.route-admission.schema.json\",\"title\":\"Kernel route admission\",\"description\":\"The check between a logical model route decision and the actual Host dispatch. Records what the Kernel requested, what the Host resolved, and the policy snapshot both were computed against, so configuration drift is detected before a worker runs. 'advisory_admitted' means the installed Host default ran and the requested class was NOT applied; it can never carry a T3 independent review.\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"admissionId\",\"runId\",\"decisionId\",\"role\",\"riskTier\",\"requested\",\"resolved\",\"policy\",\"economics\",\"decision\",\"digest\",\"createdAt\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"admissionId\":{\"type\":\"string\",\"pattern\":\"^admission-[a-f0-9]{8,64}$\"},\"runId\":{\"type\":\"string\",\"minLength\":1},\"attemptId\":{\"oneOf\":[{\"type\":\"null\"},{\"type\":\"string\",\"pattern\":\"^attempt-[a-f0-9-]{8,96}$\"}]},\"stepId\":{\"type\":[\"string\",\"null\"]},\"decisionId\":{\"type\":\"string\",\"pattern\":\"^route-[a-f0-9]{8,64}$\"},\"capsuleId\":{\"oneOf\":[{\"type\":\"null\"},{\"type\":\"string\",\"pattern\":\"^capsule-[a-f0-9]{8,64}$\"}]},\"capsuleDigest\":{\"oneOf\":[{\"type\":\"null\"},{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"}]},\"planRevision\":{\"type\":\"integer\",\"minimum\":1},\"role\":{\"enum\":[\"planner\",\"implementer\",\"reviewer\",\"kernel\"]},\"riskTier\":{\"enum\":[\"T0\",\"T1\",\"T2\",\"T3\"]},\"requested\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"modelClass\",\"permissions\",\"independentContextRequired\"],\"properties\":{\"modelClass\":{\"enum\":[\"frontier_reasoning\",\"value_coding\",\"kernel\"]},\"permissions\":{\"enum\":[\"read_only\",\"plan_write\",\"workspace_write\",\"kernel_runtime\"]},\"independentContextRequired\":{\"type\":\"boolean\"},\"role\":{\"type\":\"string\"}}},\"resolved\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"source\"],\"properties\":{\"surface\":{\"type\":[\"string\",\"null\"]},\"model\":{\"type\":[\"string\",\"null\"]},\"effort\":{\"type\":[\"string\",\"null\"]},\"source\":{\"enum\":[\"invocation-override\",\"environment\",\"profile-config\",\"host-default\",\"kernel-runtime\"]},\"adapter\":{\"type\":[\"string\",\"null\"]},\"adapterVersion\":{\"type\":\"string\"}}},\"policy\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"modelPolicyRevision\",\"profileDigest\",\"hostCapabilityDigest\",\"toolPolicyDigest\",\"permissionPolicyDigest\"],\"properties\":{\"modelPolicyRevision\":{\"type\":\"string\"},\"profileDigest\":{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"},\"hostCapabilityDigest\":{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"},\"toolPolicyDigest\":{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"},\"permissionPolicyDigest\":{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"}}},\"economics\":{\"type\":\"object\",\"additionalProperties\":false,\"properties\":{\"costClass\":{\"type\":\"string\"},\"maxCostUnits\":{\"type\":[\"number\",\"null\"]},\"estimatedCostUnits\":{\"type\":[\"number\",\"null\"]}}},\"decision\":{\"enum\":[\"admitted\",\"fallback_admitted\",\"advisory_admitted\",\"blocked\",\"redecision_required\"]},\"rejectionCode\":{\"type\":[\"string\",\"null\"]},\"createdByVersion\":{\"type\":\"string\"},\"digest\":{\"type\":\"string\",\"pattern\":\"^sha256:[a-f0-9]{64}$\"},\"createdAt\":{\"type\":\"string\",\"minLength\":1}}}"
    },
    {
        "id": "kernel.run-summary",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.run-summary.schema.json\",\"type\":\"object\",\"additionalProperties\":true,\"required\":[\"schemaVersion\",\"tier\",\"objective\",\"status\",\"evidenceRefs\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"tier\":{\"const\":\"E0\"},\"objective\":{\"type\":\"string\"},\"status\":{\"type\":\"string\"},\"evidenceRefs\":{\"type\":\"array\"}}}"
    },
    {
        "id": "kernel.runtime-manifest",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"productId\":{\"type\":\"string\"},\"runtimeHome\":{\"type\":\"string\"},\"platform\":{\"anyOf\":[{\"const\":\"aix\"},{\"const\":\"android\"},{\"const\":\"darwin\"},{\"const\":\"freebsd\"},{\"const\":\"haiku\"},{\"const\":\"linux\"},{\"const\":\"openbsd\"},{\"const\":\"sunos\"},{\"const\":\"win32\"},{\"const\":\"cygwin\"},{\"const\":\"netbsd\"}]},\"arch\":{\"type\":\"string\"},\"nodePath\":{\"type\":\"string\"},\"checksum\":{\"type\":\"string\"}},\"required\":[\"schemaVersion\",\"productId\",\"runtimeHome\",\"platform\",\"arch\",\"nodePath\",\"checksum\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.runtime-manifest.schema.json\"}"
    },
    {
        "id": "kernel.runtime-state",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.runtime-state.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"runId\",\"objective\",\"currentState\",\"state\",\"status\",\"revision\",\"mutationRevision\",\"sourceIdentity\",\"proofTier\",\"evidenceTier\",\"requiredObligations\",\"acceptanceCriteria\",\"updatedAt\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"runId\":{\"type\":\"string\"},\"objective\":{\"type\":\"string\"},\"currentState\":{\"type\":\"string\"},\"state\":{\"type\":\"string\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"mutationRevision\":{\"type\":\"integer\",\"minimum\":0},\"sourceIdentity\":{\"type\":\"string\",\"minLength\":1},\"proofTier\":{\"enum\":[\"T0\",\"T1\",\"T2\",\"T3\"]},\"evidenceTier\":{\"enum\":[\"E0\",\"E1\",\"E2\"]},\"requiredObligations\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"acceptanceCriteria\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"status\":{\"enum\":[\"active\",\"blocked\",\"completed\"]},\"updatedAt\":{\"type\":\"string\"}}}"
    },
    {
        "id": "kernel.session-source",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.session-source.schema.json\",\"type\":\"object\",\"required\":[\"schemaVersion\",\"provider\",\"nativeSessionId\",\"sourceDigest\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"provider\":{\"enum\":[\"codex\",\"claude\"]},\"nativeSessionId\":{\"type\":\"string\"},\"locator\":{\"type\":[\"string\",\"null\"]},\"workingDirectory\":{\"type\":[\"string\",\"null\"]},\"remote\":{\"type\":[\"string\",\"null\"]},\"sourceDigest\":{\"type\":\"string\"}},\"additionalProperties\":true}"
    },
    {
        "id": "kernel.state-projection",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.state-projection.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"runId\",\"runtimeRevision\",\"status\",\"currentState\",\"sourceDigest\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"runId\":{\"type\":\"string\"},\"runtimeRevision\":{\"type\":\"integer\"},\"status\":{\"type\":\"string\"},\"currentState\":{\"type\":\"string\"},\"sourceDigest\":{\"pattern\":\"^[a-f0-9]{64}$\"}}}"
    },
    {
        "id": "kernel.task-contract",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.task-contract.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"objective\",\"acceptance\",\"scope\",\"nonGoals\",\"riskTier\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"objective\":{\"type\":\"string\",\"minLength\":1},\"acceptance\":{\"type\":\"array\",\"minItems\":1,\"items\":{\"type\":\"string\"}},\"scope\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"nonGoals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"riskTier\":{\"enum\":[\"T0\",\"T1\",\"T2\",\"T3\"]},\"surfaces\":{\"type\":\"array\",\"items\":{\"enum\":[\"security_boundary\",\"data_migration\",\"public_contract\",\"schema_change\",\"runtime_authority\",\"installer\"]}},\"activeTrack\":{\"enum\":[\"relay\",\"kernel\"]}}}"
    },
    {
        "id": "kernel.task-snapshot",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"objective\":{\"type\":\"string\"},\"acceptance\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"statement\":{\"type\":\"string\"},\"evidencePlan\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"class\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"hard\"},{\"const\":\"judgment\"}]},\"method\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"commandRefs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"obligationId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"evidenceLevel\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"work\"},{\"const\":\"integration\"},{\"const\":\"goal\"}]},\"scope\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"freshnessInputs\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"outcome\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"implemented\"},{\"const\":\"verified\"},{\"const\":\"deployed\"},{\"const\":\"observed\"},{\"const\":\"resolved\"}]}},\"required\":[\"class\",\"method\",\"commandRefs\",\"obligationId\",\"evidenceLevel\",\"scope\",\"freshnessInputs\",\"outcome\"],\"additionalProperties\":false}]},\"structured\":{\"type\":\"boolean\"}},\"required\":[\"id\",\"statement\",\"evidencePlan\",\"structured\"],\"additionalProperties\":false}},\"constraints\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"nonGoals\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"risks\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"surfaces\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"taskClass\":{\"type\":\"string\"},\"requestedTier\":{},\"changeClass\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"scopeExtension\":{\"type\":\"boolean\"},\"defectWithinScope\":{\"type\":\"boolean\"},\"replacement\":{\"type\":\"boolean\"},\"requiredObligations\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"requiredVerifications\":{\"type\":\"array\",\"items\":{}},\"completionPredicate\":{\"type\":\"object\",\"properties\":{\"requiredOutcomes\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"requiredOutcomes\"],\"additionalProperties\":false},\"seedProvenance\":{},\"steps\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"stepId\":{},\"acceptanceIds\":{},\"acceptanceCoverage\":{},\"coverage\":{},\"acceptanceMapping\":{},\"obligationIds\":{}},\"required\":[],\"additionalProperties\":{}}},\"supersededStepIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"allowedPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"forbiddenPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"filesChanged\":{\"type\":\"number\"},\"strictBoundedScope\":{\"type\":\"boolean\"},\"flags\":{\"type\":\"object\",\"properties\":{},\"required\":[],\"additionalProperties\":{}},\"changedPaths\":{},\"digest\":{\"type\":\"string\"}},\"required\":[\"schemaVersion\",\"objective\",\"acceptance\",\"constraints\",\"nonGoals\",\"risks\",\"surfaces\",\"taskClass\",\"changeClass\",\"scopeExtension\",\"defectWithinScope\",\"replacement\",\"requiredObligations\",\"requiredVerifications\",\"completionPredicate\",\"steps\",\"supersededStepIds\",\"allowedPaths\",\"forbiddenPaths\",\"filesChanged\",\"strictBoundedScope\",\"flags\",\"digest\"],\"additionalProperties\":true,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.task-snapshot.schema.json\",\"title\":\"KernelTaskSnapshot\"}"
    },
    {
        "id": "kernel.track",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.track.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"track\",\"product\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"track\":{\"enum\":[\"relay\",\"kernel\"]},\"product\":{\"type\":\"string\",\"minLength\":1}}}"
    },
    {
        "id": "kernel.work-authority",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"type\":\"object\",\"properties\":{\"schemaVersion\":{\"const\":1},\"task\":{\"type\":\"object\",\"properties\":{\"runId\":{\"type\":\"string\"},\"objective\":{\"type\":\"string\"},\"taskClass\":{\"type\":\"string\"},\"contractRevision\":{\"type\":\"number\"},\"acceptanceCriteria\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"runId\",\"objective\",\"taskClass\",\"contractRevision\",\"acceptanceCriteria\"],\"additionalProperties\":false},\"run\":{\"type\":\"object\",\"properties\":{\"runId\":{\"type\":\"string\"},\"projectId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"status\":{\"type\":\"string\"},\"state\":{\"type\":\"string\"},\"planRevision\":{\"type\":\"number\"},\"mutationRevision\":{\"type\":\"number\"}},\"required\":[\"runId\",\"projectId\",\"status\",\"state\",\"planRevision\",\"mutationRevision\"],\"additionalProperties\":false},\"workUnitStatus\":{\"anyOf\":[{\"const\":\"active\"},{\"const\":\"blocked\"},{\"const\":\"complete\"}]},\"goalStatus\":{\"anyOf\":[{\"const\":\"active\"},{\"const\":\"blocked\"},{\"const\":\"complete\"}]},\"goal\":{\"type\":\"object\",\"properties\":{\"status\":{\"anyOf\":[{\"const\":\"active\"},{\"const\":\"blocked\"},{\"const\":\"complete\"}]},\"objective\":{\"type\":\"string\"},\"coverage\":{\"type\":\"object\",\"properties\":{\"completedAcceptanceCount\":{\"type\":\"number\"},\"totalAcceptanceCount\":{\"type\":\"number\"},\"summary\":{\"type\":\"string\"}},\"required\":[\"completedAcceptanceCount\",\"totalAcceptanceCount\",\"summary\"],\"additionalProperties\":false}},\"required\":[\"status\",\"objective\",\"coverage\"],\"additionalProperties\":false},\"currentWorkUnit\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"object\",\"properties\":{\"stepId\":{\"type\":\"string\"},\"sequence\":{\"type\":\"number\"},\"planRevision\":{\"type\":\"number\"},\"objective\":{\"type\":\"string\"},\"state\":{\"type\":\"string\"},\"synthetic\":{\"type\":\"boolean\"},\"acceptanceIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"obligationIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"allowedPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"forbiddenPaths\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"stepId\",\"sequence\",\"planRevision\",\"objective\",\"state\",\"synthetic\",\"acceptanceIds\",\"obligationIds\",\"allowedPaths\",\"forbiddenPaths\"],\"additionalProperties\":false}]},\"progress\":{\"type\":\"object\",\"properties\":{\"completedWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"completedCurrentPlanWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"remainingWorkUnitIds\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"completedCount\":{\"type\":\"number\"},\"completedCurrentPlanCount\":{\"type\":\"number\"},\"remainingCount\":{\"type\":\"number\"}},\"required\":[\"completedWorkUnitIds\",\"completedCurrentPlanWorkUnitIds\",\"remainingWorkUnitIds\",\"completedCount\",\"completedCurrentPlanCount\",\"remainingCount\"],\"additionalProperties\":false},\"cursor\":{\"type\":\"object\",\"properties\":{\"planRevision\":{\"type\":\"number\"},\"currentStepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]},\"currentSequence\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"number\"}]},\"stepCount\":{\"type\":\"number\"}},\"required\":[\"planRevision\",\"currentStepId\",\"currentSequence\",\"stepCount\"],\"additionalProperties\":false},\"executionClass\":{\"anyOf\":[{\"type\":\"null\"},{\"const\":\"planning\"},{\"const\":\"complex_implementation\"},{\"const\":\"review\"},{\"const\":\"standard\"}]},\"resume\":{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"action\":{\"anyOf\":[{\"const\":\"none\"},{\"const\":\"continue-current-work-unit\"},{\"const\":\"continue-work\"},{\"const\":\"rebuild-work-cursor\"}]},\"stepId\":{\"anyOf\":[{\"type\":\"null\"},{\"type\":\"string\"}]}},\"required\":[\"status\",\"action\",\"stepId\"],\"additionalProperties\":false}},\"required\":[\"schemaVersion\",\"task\",\"run\",\"workUnitStatus\",\"goalStatus\",\"goal\",\"currentWorkUnit\",\"progress\",\"cursor\",\"executionClass\",\"resume\"],\"additionalProperties\":false,\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.work-authority.schema.json\",\"title\":\"KernelWorkAuthority\"}"
    },
    {
        "id": "kernel.workflow-state",
        "draft": "https://json-schema.org/draft/2020-12/schema",
        "schemaJson": "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"$id\":\"https://moon-relay-kernel.local/schemas/kernel.workflow-state.schema.json\",\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"schemaVersion\",\"runId\",\"state\",\"history\"],\"properties\":{\"schemaVersion\":{\"const\":1},\"runId\":{\"type\":\"string\"},\"state\":{\"enum\":[\"FRAME\",\"EXECUTE\",\"PROVE\",\"CLOSE\"]},\"history\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}}}"
    }
];
export const KERNEL_CONTRACT_ENUMS = {
    "kernel.applicable-knowledge-slice": {},
    "kernel.attempt-provenance": {
        "provenanceKind": [
            "routed",
            "owner-session",
            "kernel-owned",
            "legacy-unattributed"
        ],
        "status": [
            "started",
            "passed",
            "failed",
            "interrupted",
            "superseded",
            "cancelled"
        ]
    },
    "kernel.codebase-index-manifest": {
        "status": [
            "fresh",
            "stale",
            "degraded",
            "cache_hit"
        ]
    },
    "kernel.context-receipt": {
        "stage": [
            "FRAME",
            "SHAPE",
            "SLICE",
            "SCHEDULE",
            "EXECUTE",
            "PROVE",
            "CLOSE"
        ]
    },
    "kernel.durable-state": {},
    "kernel.eval-case": {
        "taskClass": [
            "analysis",
            "bug",
            "feature",
            "refactor",
            "ui",
            "long-running"
        ],
        "riskTier": [
            "T0",
            "T1",
            "T2",
            "T3"
        ],
        "sourceKind": [
            "historical",
            "synthetic"
        ]
    },
    "kernel.execution-capsule": {
        "role": [
            "implementer",
            "reviewer",
            "planner",
            "researcher"
        ],
        "permissions.filesystem": [
            "read_only",
            "plan_write",
            "workspace_write"
        ]
    },
    "kernel.git-closeout-receipt": {
        "pushStatus": [
            "skipped",
            "completed",
            "failed"
        ],
        "parity": [
            "matched",
            "mismatched",
            "not_requested"
        ],
        "status": [
            "completed",
            "partial",
            "failed",
            "skipped"
        ]
    },
    "kernel.git-closeout-request": {
        "mode": [
            "commit",
            "commit_and_push"
        ]
    },
    "kernel.knowledge-candidate": {
        "proposedType": [
            "policy_anchor",
            "semantic_fact",
            "kg_relation",
            "ontology_constraint",
            "episodic_observation"
        ],
        "status": [
            "observed",
            "staged",
            "verified",
            "rejected",
            "committed",
            "superseded",
            "archived"
        ]
    },
    "kernel.knowledge-commit-receipt": {},
    "kernel.knowledge-contract": {
        "status": [
            "ready",
            "stale",
            "degraded_read",
            "degraded_write",
            "not_configured"
        ],
        "strictness": [
            "advisory",
            "required"
        ],
        "stage": [
            "FRAME",
            "SHAPE",
            "SLICE",
            "SCHEDULE",
            "EXECUTE",
            "PROVE",
            "CLOSE"
        ]
    },
    "kernel.knowledge-import-receipt": {
        "status": [
            "committed",
            "partial",
            "no_op"
        ]
    },
    "kernel.knowledge-import": {
        "sourceType": [
            "kernel_run",
            "codex_session",
            "claude_session",
            "provider_session",
            "codebase_index",
            "git_commit",
            "pull_request",
            "manual_statement"
        ],
        "status": [
            "discovered",
            "analyzed",
            "awaiting_review",
            "approved",
            "committed",
            "partial",
            "rejected",
            "failed",
            "no_op"
        ]
    },
    "kernel.knowledge-record": {
        "type": [
            "policy_anchor",
            "semantic_fact",
            "architecture_decision",
            "domain_term",
            "component_boundary",
            "api_contract",
            "kg_relation",
            "ontology_constraint",
            "episodic_observation",
            "known_failure_pattern",
            "required_verification",
            "provenance_event",
            "knowledge_candidate"
        ],
        "status": [
            "observed",
            "staged",
            "verified",
            "rejected",
            "committed",
            "superseded",
            "archived",
            "quarantined"
        ],
        "trustTier": [
            "authoritative",
            "verified",
            "derived",
            "quarantined",
            "degraded"
        ]
    },
    "kernel.knowledge-review-result": {},
    "kernel.measurement": {},
    "kernel.model-route": {
        "actionKind": [
            "understand",
            "design",
            "plan",
            "implement",
            "debug",
            "review_contract",
            "review_engineering",
            "replan",
            "prove",
            "close"
        ],
        "role": [
            "planner",
            "implementer",
            "reviewer",
            "kernel"
        ],
        "modelClass": [
            "kernel",
            "frontier_reasoning",
            "value_coding"
        ],
        "riskTier": [
            "T0",
            "T1",
            "T2",
            "T3"
        ],
        "workProfile.complexity": [
            "standard",
            "routine",
            "complex",
            "large-refactor"
        ],
        "permissions": [
            "read_only",
            "plan_write",
            "workspace_write",
            "kernel_runtime"
        ]
    },
    "kernel.model-usage": {
        "workProfile.complexity": [
            "standard",
            "routine",
            "complex",
            "large-refactor"
        ],
        "enforcementStatus": [
            "enforced",
            "fallback",
            "advisory",
            "unsupported",
            "failed"
        ],
        "resultStatus": [
            "failed",
            "completed",
            "interrupted",
            "abandoned"
        ],
        "cacheMode": [
            "off",
            "shadow",
            "on"
        ],
        "cacheMissReason": [
            "cold-prefix",
            "tool-schema-changed",
            "common-prefix-changed",
            "provider-prefix-changed",
            "project-prefix-changed",
            "run-prefix-changed",
            "model-changed",
            "effort-changed",
            "speed-mode-changed",
            "session-reset",
            "provider-unsupported",
            "usage-unreported",
            "unknown"
        ],
        "modelEscalationReason": [
            "risk-tier",
            "complexity",
            "repeated-failure",
            "review-policy",
            "user-request",
            "quality-regression",
            "provider-fallback",
            "unknown"
        ]
    },
    "kernel.qa-report": {
        "tier": [
            "E1",
            "E2"
        ],
        "proofTier": [
            "T1",
            "T2",
            "T3"
        ]
    },
    "kernel.release-evidence": {
        "completionDecision": [
            "accepted",
            "blocked"
        ]
    },
    "kernel.review-capsule": {
        "reviewScope.stage": [
            "contract",
            "engineering",
            "complexity"
        ]
    },
    "kernel.review-receipt": {
        "reviewStage": [
            "contract",
            "engineering",
            "complexity"
        ],
        "verdict": [
            "pass",
            "fail",
            "changes-requested"
        ],
        "findingClass": [
            "none",
            "minor",
            "important",
            "critical"
        ],
        "reviewer.enforcementStatus": [
            "enforced",
            "fallback",
            "advisory",
            "unsupported",
            "failed",
            "unrouted",
            "operator_approved"
        ]
    },
    "kernel.route-admission": {
        "role": [
            "planner",
            "implementer",
            "reviewer",
            "kernel"
        ],
        "riskTier": [
            "T0",
            "T1",
            "T2",
            "T3"
        ],
        "requested.modelClass": [
            "frontier_reasoning",
            "value_coding",
            "kernel"
        ],
        "requested.permissions": [
            "read_only",
            "plan_write",
            "workspace_write",
            "kernel_runtime"
        ],
        "resolved.source": [
            "invocation-override",
            "environment",
            "profile-config",
            "host-default",
            "kernel-runtime"
        ],
        "decision": [
            "admitted",
            "fallback_admitted",
            "advisory_admitted",
            "blocked",
            "redecision_required"
        ]
    },
    "kernel.run-summary": {},
    "kernel.runtime-manifest": {},
    "kernel.runtime-state": {
        "proofTier": [
            "T0",
            "T1",
            "T2",
            "T3"
        ],
        "evidenceTier": [
            "E0",
            "E1",
            "E2"
        ],
        "status": [
            "active",
            "blocked",
            "completed"
        ]
    },
    "kernel.session-source": {
        "provider": [
            "codex",
            "claude"
        ]
    },
    "kernel.state-projection": {},
    "kernel.task-contract": {
        "riskTier": [
            "T0",
            "T1",
            "T2",
            "T3"
        ],
        "activeTrack": [
            "relay",
            "kernel"
        ]
    },
    "kernel.task-snapshot": {},
    "kernel.track": {
        "track": [
            "relay",
            "kernel"
        ]
    },
    "kernel.work-authority": {},
    "kernel.workflow-state": {
        "state": [
            "FRAME",
            "EXECUTE",
            "PROVE",
            "CLOSE"
        ]
    }
};
